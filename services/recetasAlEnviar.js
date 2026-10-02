// ═══════════════════════════════════════════════════════════════════════════
//  Recetas al ENVIAR la orden (no al cobrar)
//
//  Antes las recetas (carne, tortilla, queso, gaseosas, vasos...) se
//  descontaban solo al cobrar. Si un ticket o una mesa nunca se cobraba, lo
//  que se preparó no salía del inventario.
//
//  Ahora, cuando la app del iPad manda una orden (POST /api/orders) o le
//  agrega productos (POST /api/orders/:id/items), se descuentan en ese momento
//  las recetas de los productos nuevos. Cada producto queda anotado en
//  `receta_descontada`, y al cobrar ya no se vuelve a descontar.
//
//  Solo aplica a lo que manda la app del iPad (no al POS web, que descuenta
//  por su cuenta). Archivo nuevo: no toca el POS web.
// ═══════════════════════════════════════════════════════════════════════════
const { QueryTypes } = require('sequelize')
const { sequelize } = require('../config/database')

let tablaLista = false
async function asegurarTabla() {
  if (tablaLista) return
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS receta_descontada (
       order_item_id INT PRIMARY KEY,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP
     )`
  )
  tablaLista = true
}

// La app del iPad usa URLSession: su User-Agent trae "CFNetwork"/"Darwin".
function esAppIOS(req) {
  const ua = String(req.headers['user-agent'] || '')
  return /CFNetwork|Darwin/i.test(ua) && !/Mozilla/i.test(ua)
}

// ── Conversión de pesos (receta en libras y producto en gramos, etc.) ──────
const GRAMOS_POR = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 }
function unidadPeso(u) {
  const t = String(u || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '')
  if (t === 'g' || t === 'gr' || t === 'grs' || t.startsWith('gramo')) return 'g'
  if (t === 'kg' || t.startsWith('kilo')) return 'kg'
  if (t === 'lb' || t === 'lbs' || t.startsWith('libra')) return 'lb'
  if (t === 'oz' || t.startsWith('onza')) return 'oz'
  return null
}
function convertirPeso(cantidad, deUnidad, aUnidad) {
  const de = unidadPeso(deUnidad), a = unidadPeso(aUnidad)
  if (!de || !a || de === a) return cantidad
  return cantidad * GRAMOS_POR[de] / GRAMOS_POR[a]
}

/** Descuenta las recetas de los productos de la orden que todavía no se descontaron. */
async function descontarOrden(orderId) {
  await asegurarTabla()
  const [items] = await sequelize.query(
    `SELECT oi.id, oi.product_name, oi.quantity
     FROM order_items oi
     LEFT JOIN receta_descontada rd ON rd.order_item_id = oi.id
     WHERE oi.order_id = ? AND rd.order_item_id IS NULL`,
    { replacements: [orderId] }
  )

  for (const item of items) {
    // Se anota primero: si dos pedidos llegan juntos, solo uno descuenta.
    const [, filas] = await sequelize.query(
      `INSERT IGNORE INTO receta_descontada (order_item_id) VALUES (?)`,
      { replacements: [item.id], type: QueryTypes.INSERT }
    )
    if (filas === 0) continue   // otro pedido ya lo descontó

    const nombre = (item.product_name || '').trim()
    const veces = Number(item.quantity || 1)
    if (!nombre || veces <= 0) continue

    const [recetas] = await sequelize.query(
      `SELECT r.inventory_item_id, r.quantity_used, r.unit AS recipe_unit, i.unit AS item_unit,
              i.name AS item_name, i.quantity AS current_qty
       FROM product_recipes r
       JOIN inventory_items i ON i.id = r.inventory_item_id
       WHERE LOWER(r.product_name) = LOWER(?) AND r.is_active = 1 AND i.is_active = 1`,
      { replacements: [nombre] }
    )

    for (const r of recetas) {
      const restar = convertirPeso(parseFloat(r.quantity_used), r.recipe_unit, r.item_unit) * veces
      await sequelize.query(
        `UPDATE inventory_items SET quantity = GREATEST(0, quantity - ?), updated_at = NOW() WHERE id = ?`,
        { replacements: [restar, r.inventory_item_id] }
      )
      await sequelize.query(
        `INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name, created_at)
         VALUES (?, 'salida', ?, ?, 'App iOS', NOW())`,
        { replacements: [r.inventory_item_id, restar, `Orden enviada: ${veces}x ${nombre}`] }
      )
      console.log(`📦 Receta al enviar: ${r.item_name} -${restar} (${veces}x ${nombre})`)
    }
  }

  if (items.length) require('./push').revisarEnSegundoPlano()
}

/** IDs de productos de la orden que ya se descontaron al enviarla. */
async function yaDescontados(orderId) {
  await asegurarTabla()
  const [rows] = await sequelize.query(
    `SELECT rd.order_item_id AS id FROM receta_descontada rd
     JOIN order_items oi ON oi.id = rd.order_item_id
     WHERE oi.order_id = ?`,
    { replacements: [orderId] }
  )
  return new Set(rows.map(r => r.id))
}

/**
 * Middleware para /api/orders: cuando la app del iPad crea una orden o le
 * agrega productos y la respuesta sale bien, descuenta las recetas.
 */
function middleware(req, res, next) {
  if (req.method !== 'POST' || !esAppIOS(req)) return next()

  const ruta = req.path || ''
  const agregar = ruta.match(/^\/(\d+)\/items\/?$/)
  const crear = ruta === '/' || ruta === ''
  if (!agregar && !crear) return next()

  let orderId = agregar ? Number(agregar[1]) : null
  const jsonOriginal = res.json.bind(res)
  res.json = (body) => {
    if (!orderId && body && body.data) orderId = body.data.id || body.data.order_id || null
    return jsonOriginal(body)
  }

  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300 || !orderId) return
    descontarOrden(orderId).catch(err =>
      console.error('⚠️ Receta al enviar:', err.message)
    )
  })
  next()
}

module.exports = { middleware, descontarOrden, yaDescontados, asegurarTabla }
