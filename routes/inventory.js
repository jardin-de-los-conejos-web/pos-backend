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
// Cuánto se USÓ de cada producto del inventario en un rango de fechas (hora de Guatemala).
// Solo lectura. Uso = salidas − lo que se devolvió por cancelar, eliminar o reconstruir órdenes.
// No cuenta compras (entradas), ajustes ni las correcciones manuales.
router.get('/usage', async (req, res) => {
  try {
    const re = /^\d{4}-\d{2}-\d{2}$/
    const from = re.test(req.query.from || '') ? req.query.from : null
    const to = re.test(req.query.to || '') ? req.query.to : from
    if (!from || !to) return res.status(400).json({ success: false, message: 'Falta from y to (YYYY-MM-DD)' })

    // Guatemala es UTC-6: el día empieza a las 06:00 UTC
    const [rows] = await sequelize.query(
      `SELECT i.id, i.name, i.unit, i.category, i.quantity AS stock_actual,
         COALESCE(SUM(CASE WHEN m.type = 'salida'
                            AND COALESCE(m.reason,'') NOT LIKE 'Correcci%' THEN m.quantity ELSE 0 END), 0) AS usado,
         COALESCE(SUM(CASE WHEN m.type = 'entrada' AND (
                              COALESCE(m.reason,'') LIKE 'Orden cancelada%' OR COALESCE(m.reason,'') LIKE 'Orden eliminada%'
                           OR COALESCE(m.reason,'') LIKE 'Cambio: regresa%' OR COALESCE(m.reason,'') LIKE 'Reconstrucci%'
                           OR COALESCE(m.reason,'') LIKE 'Se deshizo receta%') THEN m.quantity ELSE 0 END), 0) AS devuelto,
         COALESCE(SUM(CASE WHEN m.type = 'salida'
                            AND COALESCE(m.reason,'') NOT LIKE 'Correcci%' THEN 1 ELSE 0 END), 0) AS movimientos
       FROM inventory_items i
       JOIN inventory_movements m ON m.item_id = i.id
       WHERE i.is_active = 1
         AND m.created_at >= DATE_ADD(?, INTERVAL 6 HOUR)
         AND m.created_at <  DATE_ADD(DATE_ADD(?, INTERVAL 1 DAY), INTERVAL 6 HOUR)
       GROUP BY i.id, i.name, i.unit, i.category, i.quantity`,
      { replacements: [from, to] }
    )

    const data = rows
      .map(r => {
        const usado = Number(r.usado), devuelto = Number(r.devuelto)
        return {
          id: r.id, name: r.name, unit: r.unit, category: r.category,
          stock_actual: Number(r.stock_actual),
          usado: Math.round(usado * 100) / 100,
          devuelto: Math.round(devuelto * 100) / 100,
          neto: Math.round(Math.max(0, usado - devuelto) * 100) / 100,
          movimientos: Number(r.movimientos),
        }
      })
      .filter(r => r.neto > 0)
      .sort((a, b) => b.neto - a.neto)

    res.json({ success: true, from, to, data })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

module.exports = router