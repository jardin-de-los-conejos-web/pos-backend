const express = require('express')
const router  = express.Router()
const { sequelize } = require('../config/database')
const push = require('../services/push')

// ── GET /api/inventory ─────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const [items] = await sequelize.query(
      `SELECT * FROM inventory_items WHERE is_active = 1 ORDER BY category ASC, name ASC`
    )
    res.json({ success: true, data: items })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ── POST /api/inventory ────────────────────────────────
// Crear nuevo ítem
router.post('/', async (req, res) => {
  try {
    const { name, description, quantity, unit, min_stock, cost_per_unit, category, user_name } = req.body
    if (!name) return res.status(400).json({ success: false, message: 'El nombre es requerido' })

    const [result] = await sequelize.query(
      `INSERT INTO inventory_items (name, description, quantity, unit, min_stock, cost_per_unit, category)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [
        name,
        description || null,
        parseFloat(quantity) || 0,
        unit || 'unidades',
        parseFloat(min_stock) || 0,
        parseFloat(cost_per_unit) || 0,
        category || 'general'
      ]}
    )

    const itemId = result

    // Registrar movimiento inicial si hay cantidad
    if (parseFloat(quantity) > 0) {
      await sequelize.query(
        `INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name)
         VALUES (?, 'entrada', ?, 'Stock inicial', ?)`,
        { replacements: [itemId, parseFloat(quantity), user_name || 'Sistema'] }
      )
    }

    const [[newItem]] = await sequelize.query(
      `SELECT * FROM inventory_items WHERE id = ?`, { replacements: [itemId] }
    )

    res.status(201).json({ success: true, data: newItem, message: 'Ítem creado exitosamente' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ── PUT /api/inventory/:id ─────────────────────────────
// Actualizar datos del ítem
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, description, unit, min_stock, cost_per_unit, category } = req.body

    await sequelize.query(
      `UPDATE inventory_items SET name=?, description=?, unit=?, min_stock=?, cost_per_unit=?, category=?, updated_at=NOW()
       WHERE id=?`,
      { replacements: [name, description || null, unit || 'unidades',
          parseFloat(min_stock) || 0, parseFloat(cost_per_unit) || 0,
          category || 'general', id] }
    )

    const [[item]] = await sequelize.query(
      `SELECT * FROM inventory_items WHERE id=?`, { replacements: [id] }
    )
    push.revisarEnSegundoPlano()   // por si cambió el mínimo
    res.json({ success: true, data: item })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ── POST /api/inventory/:id/adjust ────────────────────
// Ajustar cantidad (entrada / salida / ajuste)
router.post('/:id/adjust', async (req, res) => {
  try {
    const { id } = req.params
    const { type, quantity, reason, user_name } = req.body
    // type: 'entrada' | 'salida' | 'ajuste'

    const [[item]] = await sequelize.query(
      `SELECT * FROM inventory_items WHERE id=? AND is_active=1`, { replacements: [id] }
    )
    if (!item) return res.status(404).json({ success: false, message: 'Ítem no encontrado' })

    let newQty
    const qty = parseFloat(quantity)
    if (type === 'ajuste') {
      newQty = qty  // ajuste directo al valor
    } else if (type === 'entrada') {
      newQty = parseFloat(item.quantity) + qty
    } else {  // salida
      newQty = Math.max(0, parseFloat(item.quantity) - qty)
    }

    await sequelize.query(
      `UPDATE inventory_items SET quantity=?, updated_at=NOW() WHERE id=?`,
      { replacements: [newQty, id] }
    )

    await sequelize.query(
      `INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name)
       VALUES (?, ?, ?, ?, ?)`,
      { replacements: [id, type, qty, reason || null, user_name || 'Sistema'] }
    )

    push.revisarEnSegundoPlano()   // avisa a los iPads si quedó en stock bajo
    res.json({ success: true, data: { id: parseInt(id), quantity: newQty }, message: 'Stock actualizado' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ── DELETE /api/inventory/:id ──────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE inventory_items SET is_active=0 WHERE id=?`, { replacements: [req.params.id] }
    )
    res.json({ success: true, message: 'Ítem eliminado' })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ── GET /api/inventory/:id/movements ──────────────────
router.get('/:id/movements', async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT * FROM inventory_movements WHERE item_id=? ORDER BY created_at DESC LIMIT 50`,
      { replacements: [req.params.id] }
    )
    res.json({ success: true, data: rows })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ── GET /api/inventory/usage?from=YYYY-MM-DD&to=YYYY-MM-DD ─────────────
// Cuánto se USÓ de cada producto del inventario en un rango de fechas (hora de Guatemala),
// y EN QUÉ productos se usó (licuado, crepa, gringa...). Solo lectura.
// Uso = salidas − lo que se devolvió por cancelar, eliminar o reconstruir órdenes.
// No cuenta compras (entradas), ajustes ni las correcciones manuales.

const SIN_DETALLE = 'Pedido del POS (sin detalle)'

/** Saca el nombre del producto vendido a partir del motivo del movimiento. */
function productoDelMotivo(reason) {
  const r = String(reason || '').trim()
  let m
  // "Venta: 2x Gringa", "Venta 2026-10-01: 2x Gringa", "Venta: 1x Crepa de Frutas (Banano 300 g)"
  if ((m = r.match(/^Venta(?: \d{4}-\d{2}-\d{2})?: [\d.]+x (.+)$/))) return limpiar(m[1])
  // "Venta: Licuado Grande · 8.0 oz x 2", "Venta: Café (2 vasos)", "Venta: Gringa x3"
  if ((m = r.match(/^Venta: (.+?) · [\d.]+ oz x \d+/))) return limpiar(m[1])
  if ((m = r.match(/^Venta: (.+?) \(\d+ vasos?\)/))) return limpiar(m[1])
  if ((m = r.match(/^Venta: (.+?) x\d+$/))) return limpiar(m[1])
  // Devoluciones: "Orden cancelada: 2x Gringa", "Orden eliminada: 1x X", "Cambio: regresa 1x X",
  // "Reconstrucción 2026-10-01: quita 2x X"
  if ((m = r.match(/^(?:Orden cancelada|Orden eliminada): [\d.]+x (.+)$/))) return limpiar(m[1])
  if ((m = r.match(/^Cambio: regresa [\d.]+x (.+)$/))) return limpiar(m[1])
  if ((m = r.match(/^Reconstrucci[oó]n [\d-]+: quita [\d.]+x (.+)$/))) return limpiar(m[1])
  // Lo que la app descuenta por producto: "Usado en pedido del POS · Licuado Grande"
  if ((m = r.match(/^Usado en pedido del POS · (.+)$/))) return limpiar(m[1])
  if (/^Usado en pedido del POS/.test(r)) return SIN_DETALLE
  if (/^Pedido para llevar/.test(r)) return 'Empaque para llevar'
  return 'Otros movimientos'
}

/** Quita lo que va entre paréntesis (gramos, sabores) para juntar el mismo producto. */
function limpiar(nombre) {
  return String(nombre).replace(/\s*\(.*\)\s*$/, '').trim() || 'Otros movimientos'
}

const ES_DEVOLUCION = /^(Orden cancelada|Orden eliminada|Cambio: regresa|Reconstrucci|Se deshizo receta)/

router.get('/usage', async (req, res) => {
  try {
    const re = /^\d{4}-\d{2}-\d{2}$/
    const from = re.test(req.query.from || '') ? req.query.from : null
    const to = re.test(req.query.to || '') ? req.query.to : from
    if (!from || !to) return res.status(400).json({ success: false, message: 'Falta from y to (YYYY-MM-DD)' })

    // Guatemala es UTC-6: el día empieza a las 06:00 UTC
    const [rows] = await sequelize.query(
      `SELECT i.id, i.name, i.unit, i.category, i.quantity AS stock_actual,
              m.type, m.quantity, COALESCE(m.reason, '') AS reason
       FROM inventory_items i
       JOIN inventory_movements m ON m.item_id = i.id
       WHERE i.is_active = 1
         AND m.type IN ('salida', 'entrada')
         AND m.created_at >= DATE_ADD(?, INTERVAL 6 HOUR)
         AND m.created_at <  DATE_ADD(DATE_ADD(?, INTERVAL 1 DAY), INTERVAL 6 HOUR)`,
      { replacements: [from, to] }
    )

    const r2 = v => Math.round(v * 100) / 100
    const porItem = new Map()
    for (const r of rows) {
      const esSalida = r.type === 'salida' && !/^Correcci/.test(r.reason)
      const esDevol = r.type === 'entrada' && ES_DEVOLUCION.test(r.reason)
      if (!esSalida && !esDevol) continue

      let it = porItem.get(r.id)
      if (!it) {
        it = { id: r.id, name: r.name, unit: r.unit, category: r.category,
               stock_actual: Number(r.stock_actual), usado: 0, devuelto: 0, movimientos: 0, productos: new Map() }
        porItem.set(r.id, it)
      }
      const q = Number(r.quantity)
      const prod = productoDelMotivo(r.reason)
      if (esSalida) {
        it.usado += q; it.movimientos += 1
        it.productos.set(prod, (it.productos.get(prod) || 0) + q)
      } else {
        it.devuelto += q
        it.productos.set(prod, (it.productos.get(prod) || 0) - q)
      }
    }

    const data = [...porItem.values()]
      .map(it => ({
        id: it.id, name: it.name, unit: it.unit, category: it.category,
        stock_actual: it.stock_actual,
        usado: r2(it.usado),
        devuelto: r2(it.devuelto),
        neto: r2(Math.max(0, it.usado - it.devuelto)),
        movimientos: it.movimientos,
        por_producto: [...it.productos.entries()]
          .map(([producto, cantidad]) => ({ producto, cantidad: r2(cantidad) }))
          .filter(p => p.cantidad > 0)
          .sort((a, b) => b.cantidad - a.cantidad),
      }))
      .filter(it => it.neto > 0)
      .sort((a, b) => b.neto - a.neto)

    res.json({ success: true, from, to, data })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

module.exports = router