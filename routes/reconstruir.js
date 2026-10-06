// ═══════════════════════════════════════════════════════════════════════════
//  Reconstruir un día completo a partir de los recibos (ventas hechas fuera
//  de la app, por ejemplo en otro punto de venta).
//
//  POST /api/reconstruir-dia
//  body: {
//    date: 'YYYY-MM-DD',
//    dry_run: true|false,            // true = solo muestra qué haría
//    recibos: [{
//      ref: '4-7376', hora: '11:19', // hora de Guatemala
//      efectivo: 20, tarjeta: 54,    // cuánto se pagó de cada forma
//      items: [{ product_name, unit_price, quantity, notes? }]
//    }]
//  }
//
//  Qué hace (si no es dry_run):
//   1. Regresa al inventario las recetas de las órdenes que ya había ese día.
//   2. Borra esas órdenes (productos, pagos, número de cocina) y las
//      transacciones del día (pos_transactions).
//   3. Crea una orden cobrada por cada recibo, con su hora, sus pagos y su
//      fila en pos_transactions (para cierre y estadísticas).
//   4. Descuenta del inventario las recetas de los productos nuevos.
//  Las frutas no se tocan (no hay gramos en los recibos).
//
//  Archivo nuevo: no toca el POS web.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')
const { protect, requireSupervisor } = require('../middleware/auth')
const recetas = require('../services/recetasAlEnviar')

const num = v => Number(v || 0)
const r2 = v => Math.round(v * 100) / 100

/** 'YYYY-MM-DD' + 'HH:MM' de Guatemala → Date (UTC) */
function fechaGT(date, hora) {
  const [h, m] = String(hora || '12:00').split(':').map(Number)
  return new Date(Date.UTC(...date.split('-').map((x, i) => i === 1 ? Number(x) - 1 : Number(x)), h + 6, m || 0))
}

// Productos del menú que en inventario se llaman distinto
const ALIAS_INVENTARIO = {
  'gaseosa naranja': 'Naranja',
  'gaseosa uva': 'Fanta Uva',
  'gaseosa sprite': 'Sprite',
}

async function moverReceta(nombre, veces, tipo, motivo) {
  if (!nombre || veces <= 0) return
  const limpio = String(nombre).trim()
  let [rs] = await sequelize.query(
    `SELECT r.inventory_item_id, r.quantity_used, r.unit AS recipe_unit, i.unit AS item_unit
     FROM product_recipes r JOIN inventory_items i ON i.id = r.inventory_item_id
     WHERE LOWER(r.product_name) = LOWER(?) AND r.is_active = 1 AND i.is_active = 1`,
    { replacements: [limpio] }
  )
  if (!rs.length) {
    // Sin receta: el producto de inventario con el mismo nombre (o su equivalente)
    const nombreInv = ALIAS_INVENTARIO[limpio.toLowerCase()] || limpio
    ;[rs] = await sequelize.query(
      `SELECT id AS inventory_item_id, 1 AS quantity_used, unit AS recipe_unit, unit AS item_unit
       FROM inventory_items WHERE LOWER(name) = LOWER(?) AND is_active = 1 LIMIT 1`,
      { replacements: [nombreInv] }
    )
  }
  for (const r of rs) {
    const cantidad = recetas.convertirPeso(parseFloat(r.quantity_used), r.recipe_unit, r.item_unit) * veces
    await sequelize.query(
      tipo === 'entrada'
        ? `UPDATE inventory_items SET quantity = quantity + ?, updated_at = NOW() WHERE id = ?`
        : `UPDATE inventory_items SET quantity = GREATEST(0, quantity - ?), updated_at = NOW() WHERE id = ?`,
      { replacements: [cantidad, r.inventory_item_id] }
    )
    await sequelize.query(
      `INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name, created_at)
       VALUES (?, ?, ?, ?, 'Reconstrucción', NOW())`,
      { replacements: [r.inventory_item_id, tipo, cantidad, motivo] }
    )
  }
}

// Borra y recrea un día completo: solo un supervisor con sesión iniciada.
router.post('/', protect, requireSupervisor, async (req, res) => {
  try {
    const { date, recibos, dry_run } = req.body || {}
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Array.isArray(recibos) || !recibos.length) {
      return res.status(400).json({ success: false, message: 'Falta date o recibos' })
    }
    await recetas.asegurarTabla()

    // Validar recibos
    for (const r of recibos) {
      const total = r2((r.items || []).reduce((s, i) => s + num(i.unit_price) * num(i.quantity), 0))
      const pagado = r2(num(r.efectivo) + num(r.tarjeta))
      if (!r.ref || !(r.items || []).length || Math.abs(total - pagado) > 0.01) {
        return res.status(400).json({ success: false, message: `Recibo ${r.ref}: total ${total} no cuadra con pagos ${pagado}` })
      }
    }

    const desde = fechaGT(date, '00:00')
    const hasta = new Date(desde.getTime() + 24 * 60 * 60 * 1000)
    const [viejas] = await sequelize.query(
      `SELECT id, status, total FROM orders WHERE created_at >= ? AND created_at < ?`,
      { replacements: [desde, hasta] }
    )
    const idsViejas = viejas.map(o => o.id)
    const nuevo = {
      ordenes: recibos.length,
      total: r2(recibos.reduce((s, r) => s + num(r.efectivo) + num(r.tarjeta), 0)),
      efectivo: r2(recibos.reduce((s, r) => s + num(r.efectivo), 0)),
      tarjeta: r2(recibos.reduce((s, r) => s + num(r.tarjeta), 0)),
    }
    const antes = { ordenes: viejas.length, total: r2(viejas.reduce((s, o) => s + num(o.total), 0)) }
    if (dry_run) return res.json({ success: true, dry_run: true, date, antes, nuevo })

    // 1) Regresar inventario de lo que había
    if (idsViejas.length) {
      const [itemsViejos] = await sequelize.query(
        `SELECT oi.product_name, oi.quantity FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.order_id IN (?) AND o.status <> 'cancelled'`,
        { replacements: [idsViejas] }
      )
      for (const it of itemsViejos) {
        await moverReceta(it.product_name, num(it.quantity), 'entrada', `Reconstrucción ${date}: quita ${num(it.quantity)}x ${it.product_name}`)
      }

      // 2) Borrar lo que había
      await sequelize.query(`DELETE FROM payments WHERE order_id IN (?)`, { replacements: [idsViejas] })
      await sequelize.query(
        `DELETE FROM receta_descontada WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id IN (?))`,
        { replacements: [idsViejas] }
      )
      await sequelize.query(`DELETE FROM order_items WHERE order_id IN (?)`, { replacements: [idsViejas] })
      await sequelize.query(`DELETE FROM cocina_order_numbers WHERE order_id IN (?)`, { replacements: [idsViejas] })
      await sequelize.query(`DELETE FROM orders WHERE id IN (?)`, { replacements: [idsViejas] })
    }
    await sequelize.query(`DELETE FROM pos_transactions WHERE transaction_date = ?`, { replacements: [date] })

    // Ids del menú por nombre (si el producto existe)
    const [prods] = await sequelize.query(`SELECT id, name FROM products`)
    const idDe = {}
    for (const p of prods) idDe[String(p.name).toLowerCase()] = p.id

    // 3) Crear cada recibo
    for (const r of recibos) {
      const cuando = fechaGT(date, r.hora)
      const total = r2(r.items.reduce((s, i) => s + num(i.unit_price) * num(i.quantity), 0))
      const [orderId] = await sequelize.query(
        `INSERT INTO orders (order_number, table_id, customer_name, customer_count, type, notes, subtotal, tax_amount,
                             discount_amount, total, status, opened_at, closed_at, created_at, updated_at)
         VALUES (?, NULL, 'Ventas del día', 1, 'dine_in', NULL, ?, 0, 0, ?, 'paid', ?, ?, ?, ?)`,
        { replacements: [`VTA-${r.ref}`.slice(0, 20), total, total, cuando, cuando, cuando, cuando] }
      )

      for (const i of r.items) {
        const cant = num(i.quantity), precio = num(i.unit_price)
        const [itemId] = await sequelize.query(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, notes,
                                    status, discount_amount, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'served', 0, ?, ?)`,
          { replacements: [orderId, idDe[String(i.product_name).toLowerCase()] || null, i.product_name, precio, cant,
            r2(precio * cant), i.notes || null, cuando, cuando] }
        )
        await sequelize.query(`INSERT IGNORE INTO receta_descontada (order_item_id) VALUES (?)`, { replacements: [itemId] })
        await moverReceta(i.product_name, cant, 'salida', `Venta ${date}: ${cant}x ${i.product_name}`)
      }

      const itemsJSON = JSON.stringify(r.items.map(i => ({
        name: i.product_name, category: 'otros', quantity: num(i.quantity), price: num(i.unit_price),
      })))
      const partes = [['cash', 'efectivo', num(r.efectivo)], ['card', 'tarjeta', num(r.tarjeta)]].filter(p => p[2] > 0)
      let n = 0
      for (const [metodo, metodoPos, monto] of partes) {
        n += 1
        await sequelize.query(
          `INSERT INTO payments (order_id, payment_number, method, amount_paid, change_given, tip_amount, cash_amount,
                                 card_amount, transfer_amount, status, notes, paid_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 0, ?, ?, 0, 'completed', NULL, ?, ?, ?)`,
          { replacements: [orderId, `VTA-${r.ref}-${n}`.slice(0, 20), metodo, monto,
            metodo === 'cash' ? monto : 0, metodo === 'card' ? monto : 0, cuando, cuando, cuando] }
        )
        await sequelize.query(
          `INSERT INTO pos_transactions (transaction_date, table_number, person, method, amount, items, user_name, created_at)
           VALUES (?, 0, 1, ?, ?, ?, 'Ventas del día', ?)`,
          { replacements: [date, metodoPos, monto, n === 1 ? itemsJSON : '[]', cuando] }
        )
      }
    }

    require('../services/push').revisarEnSegundoPlano()
    res.json({ success: true, date, antes, nuevo })
  } catch (err) {
    console.error('reconstruir-dia error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router
