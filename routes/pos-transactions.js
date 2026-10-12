const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')
const { protect, requireSupervisor } = require('../middleware/auth')
const { validateDate, saveDailySummary } = require('../services/dailySummaries')

function todayGT() {
  const now = new Date()
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guatemala',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

// ── Helper: descontar ingredientes del inventario ─────────────────────────────
// Se llama después de cada venta registrada en pos_transactions
async function deductInventory(items) {
  if (!Array.isArray(items) || items.length === 0) return

  for (const item of items) {
    const productName = (item.name || '').trim()
    const qtySold = Number(item.quantity || 1)
    if (!productName || qtySold <= 0) continue

    // Buscar recetas que coincidan con este producto (case-insensitive)
    const [recipes] = await sequelize.query(
      `SELECT r.inventory_item_id, r.quantity_used, i.name as item_name, i.quantity as current_qty
       FROM product_recipes r
       JOIN inventory_items i ON i.id = r.inventory_item_id
       WHERE LOWER(r.product_name) = LOWER(?) AND r.is_active = 1 AND i.is_active = 1`,
      { replacements: [productName] }
    )

    for (const recipe of recipes) {
      const toDeduct = recipe.quantity_used * qtySold
      const newQty = Math.max(0, Number(recipe.current_qty) - toDeduct)

      await sequelize.query(
        `UPDATE inventory_items SET quantity = ?, updated_at = NOW() WHERE id = ?`,
        { replacements: [newQty, recipe.inventory_item_id] }
      )

      // Registrar movimiento automático
      await sequelize.query(
        `INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name, created_at)
         VALUES (?, 'salida', ?, ?, 'Sistema (venta)', NOW())`,
        { replacements: [
            recipe.inventory_item_id,
            toDeduct,
            `Venta: ${qtySold}x ${productName}`
          ]
        }
      )

      console.log(`📦 Inventario: ${recipe.item_name} ${recipe.current_qty} → ${newQty} (vendido: ${qtySold}x ${productName})`)
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  POST /api/pos-transactions
// ═══════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const { tableNumber, person, method, amount, items, userName } = req.body

    if (!tableNumber || !method || !amount || !items) {
      return res.status(400).json({ success: false, message: 'Datos incompletos' })
    }

    const today = todayGT()

    await sequelize.query(
      `INSERT INTO pos_transactions (transaction_date, table_number, person, method, amount, items, user_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [today, tableNumber, person || 0, method, amount, JSON.stringify(items), userName || ''] }
    )

    // Descontar ingredientes del inventario (no bloquea la respuesta si falla)
    try {
      await deductInventory(items)
    } catch (invErr) {
      console.error('⚠️ Error descontando inventario (venta guardada igual):', invErr.message)
    }

    res.json({ success: true, message: 'Transacción guardada' })
  } catch (err) {
    console.error('pos-transactions POST error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/pos-transactions/stats?date=2026-06-09
// ═══════════════════════════════════════════════════════════════
router.get('/stats', async (req, res) => {
  try {
    const date = req.query.date || todayGT()

    const [summary] = await sequelize.query(
      `SELECT 
         COUNT(*) as total_transactions,
         COALESCE(SUM(amount), 0) as total_revenue,
         COALESCE(SUM(CASE WHEN method = 'efectivo' THEN amount ELSE 0 END), 0) as efectivo,
         COALESCE(SUM(CASE WHEN method = 'tarjeta' THEN amount ELSE 0 END), 0) as tarjeta,
         COALESCE(SUM(CASE WHEN method = 'transferencia' THEN amount ELSE 0 END), 0) as transferencia
       FROM pos_transactions WHERE transaction_date = ?`,
      { replacements: [date] }
    )

    const [transactions] = await sequelize.query(
      `SELECT items FROM pos_transactions WHERE transaction_date = ?`,
      { replacements: [date] }
    )

    const productMap = {}
    for (const tx of transactions) {
      let items = tx.items
      if (typeof items === 'string') { try { items = JSON.parse(items) } catch { continue } }
      if (!Array.isArray(items)) continue
      for (const item of items) {
        const key = item.name
        if (!productMap[key]) productMap[key] = { name: key, quantity: 0, category: item.category || 'otros' }
        productMap[key].quantity += item.quantity || 1
      }
    }

    res.json({ success: true, date, summary: summary[0], products: Object.values(productMap).sort((a, b) => b.quantity - a.quantity) })
  } catch (err) {
    console.error('pos-transactions GET stats error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/pos-transactions/stats-range
// ═══════════════════════════════════════════════════════════════
router.get('/stats-range', async (req, res) => {
  try {
    const today = todayGT()
    const from = req.query.from || today
    const to   = req.query.to   || today

    const [summary] = await sequelize.query(
      `SELECT 
         COUNT(*) as total_transactions,
         COALESCE(SUM(amount), 0) as total_revenue,
         COALESCE(SUM(CASE WHEN method = 'efectivo' THEN amount ELSE 0 END), 0) as efectivo,
         COALESCE(SUM(CASE WHEN method = 'tarjeta' THEN amount ELSE 0 END), 0) as tarjeta,
         COALESCE(SUM(CASE WHEN method = 'transferencia' THEN amount ELSE 0 END), 0) as transferencia
       FROM pos_transactions WHERE transaction_date BETWEEN ? AND ?`,
      { replacements: [from, to] }
    )

    const [byDay] = await sequelize.query(
      `SELECT 
         transaction_date as date,
         COALESCE(SUM(amount), 0) as total_revenue,
         COALESCE(SUM(CASE WHEN method = 'efectivo' THEN amount ELSE 0 END), 0) as efectivo,
         COALESCE(SUM(CASE WHEN method = 'tarjeta' THEN amount ELSE 0 END), 0) as tarjeta,
         COALESCE(SUM(CASE WHEN method = 'transferencia' THEN amount ELSE 0 END), 0) as transferencia
       FROM pos_transactions WHERE transaction_date BETWEEN ? AND ?
       GROUP BY transaction_date ORDER BY transaction_date ASC`,
      { replacements: [from, to] }
    )

    const [transactions] = await sequelize.query(
      `SELECT items, amount FROM pos_transactions WHERE transaction_date BETWEEN ? AND ?`,
      { replacements: [from, to] }
    )

    const productMap = {}, categoryMap = {}
    for (const tx of transactions) {
      let items = tx.items
      if (typeof items === 'string') { try { items = JSON.parse(items) } catch { continue } }
      if (!Array.isArray(items)) continue
      for (const item of items) {
        const name = item.name, category = item.category || 'otros'
        const qty = item.quantity || 1, lineRevenue = (item.price ? item.price * qty : 0)
        if (!productMap[name]) productMap[name] = { name, category, quantity: 0, revenue: 0 }
        productMap[name].quantity += qty; productMap[name].revenue += lineRevenue
        if (!categoryMap[category]) categoryMap[category] = { category, quantity: 0, revenue: 0 }
        categoryMap[category].quantity += qty; categoryMap[category].revenue += lineRevenue
      }
    }

    res.json({
      success: true, from, to, summary: summary[0], byDay,
      products:    Object.values(productMap).sort((a, b) => b.quantity - a.quantity),
      categories:  Object.values(categoryMap).sort((a, b) => b.quantity - a.quantity),
    })
  } catch (err) {
    console.error('pos-transactions GET stats-range error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/pos-transactions/expenses
// ═══════════════════════════════════════════════════════════════
router.post('/expenses', async (req, res) => {
  try {
    const { description, amount, userName, date } = req.body
    if (!description || !amount) return res.status(400).json({ success: false, message: 'Datos incompletos' })
    const expenseDate = date || todayGT()
    await sequelize.query(
      `INSERT INTO pos_expenses (expense_date, description, amount, user_name) VALUES (?, ?, ?, ?)`,
      { replacements: [expenseDate, description, amount, userName || ''] }
    )
    res.json({ success: true, message: 'Gasto guardado' })
  } catch (err) {
    console.error('pos-transactions POST expenses error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/pos-transactions/expenses?date=
// ═══════════════════════════════════════════════════════════════
router.get('/expenses', async (req, res) => {
  try {
    const date = req.query.date || todayGT()
    const [expenses] = await sequelize.query(
      `SELECT id, expense_date, description, amount, user_name, created_at
       FROM pos_expenses WHERE expense_date = ? ORDER BY created_at DESC`,
      { replacements: [date] }
    )
    const total = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0)
    res.json({ success: true, date, data: expenses, total })
  } catch (err) {
    console.error('pos-transactions GET expenses error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/pos-transactions/expenses-range
// ═══════════════════════════════════════════════════════════════
router.get('/expenses-range', async (req, res) => {
  try {
    const today = todayGT()
    const from = req.query.from || today, to = req.query.to || today
    const [expenses] = await sequelize.query(
      `SELECT id, expense_date, description, amount, user_name, created_at
       FROM pos_expenses WHERE expense_date BETWEEN ? AND ?
       ORDER BY expense_date ASC, created_at ASC`,
      { replacements: [from, to] }
    )
    const total = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0)
    res.json({ success: true, from, to, data: expenses, total })
  } catch (err) {
    console.error('pos-transactions GET expenses-range error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  DELETE /api/pos-transactions/expenses/:id
// ═══════════════════════════════════════════════════════════════
router.delete('/expenses/:id', protect, requireSupervisor, async (req, res) => {
  try {
    await sequelize.query(`DELETE FROM pos_expenses WHERE id = ?`, { replacements: [req.params.id] })
    res.json({ success: true, message: 'Gasto eliminado' })
  } catch (err) {
    console.error('pos-transactions DELETE expense error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/pos-transactions/cierre
// ═══════════════════════════════════════════════════════════════
router.post('/cierre', protect, async (req, res) => {
  try {
    const {
      date, fondoInicial, cobrosEfectivo, reembolsosEfectivo, gastosDia,
      efectivoTeorico, efectivoReal, descuadre, ventasBrutas, ventasNetas,
      efectivo, tarjeta, transferencia, gananciaNeta, userName,
    } = req.body
    const cierreDate = validateDate(date ?? todayGT())
    await sequelize.transaction(async transaction => {
    await sequelize.query(
      `INSERT INTO pos_cierres
        (cierre_date, fondo_inicial, cobros_efectivo, reembolsos_efectivo, gastos_dia,
         efectivo_teorico, efectivo_real, descuadre, ventas_brutas, ventas_netas,
         efectivo, tarjeta, transferencia, ganancia_neta, user_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         fondo_inicial=VALUES(fondo_inicial), cobros_efectivo=VALUES(cobros_efectivo),
         reembolsos_efectivo=VALUES(reembolsos_efectivo), gastos_dia=VALUES(gastos_dia),
         efectivo_teorico=VALUES(efectivo_teorico), efectivo_real=VALUES(efectivo_real),
         descuadre=VALUES(descuadre), ventas_brutas=VALUES(ventas_brutas),
         ventas_netas=VALUES(ventas_netas), efectivo=VALUES(efectivo),
         tarjeta=VALUES(tarjeta), transferencia=VALUES(transferencia),
         ganancia_neta=VALUES(ganancia_neta), user_name=VALUES(user_name)`,
      { replacements: [
          cierreDate, fondoInicial||0, cobrosEfectivo||0, reembolsosEfectivo||0, gastosDia||0,
          efectivoTeorico||0, efectivoReal||0, descuadre||0, ventasBrutas||0, ventasNetas||0,
          efectivo||0, tarjeta||0, transferencia||0, gananciaNeta||0, userName||''
        ], transaction
      }
    )
    await saveDailySummary(cierreDate, transaction)
    })
    res.json({ success: true, message: 'Cierre guardado' })
  } catch (err) {
    console.error('pos-transactions POST cierre error:', err)
    res.status(err.status || 500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/pos-transactions/cierre?date=
// ═══════════════════════════════════════════════════════════════
router.get('/cierre', async (req, res) => {
  try {
    const date = req.query.date || todayGT()
    const [rows] = await sequelize.query(
      `SELECT * FROM pos_cierres WHERE cierre_date = ? LIMIT 1`, { replacements: [date] }
    )
    res.json({ success: true, date, data: rows[0] || null })
  } catch (err) {
    console.error('pos-transactions GET cierre error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/pos-transactions/days
// ═══════════════════════════════════════════════════════════════
router.get('/days', async (req, res) => {
  try {
    const [days] = await sequelize.query(
      `SELECT 
         transaction_date as date,
         COUNT(*) as total_transactions,
         SUM(amount) as total_revenue,
         SUM(CASE WHEN method = 'efectivo' THEN amount ELSE 0 END) as efectivo,
         SUM(CASE WHEN method = 'tarjeta' THEN amount ELSE 0 END) as tarjeta,
         SUM(CASE WHEN method = 'transferencia' THEN amount ELSE 0 END) as transferencia
       FROM pos_transactions
       WHERE transaction_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
       GROUP BY transaction_date ORDER BY transaction_date DESC`,
      {}
    )
    res.json({ success: true, data: days })
  } catch (err) {
    console.error('pos-transactions GET days error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  DELETE /api/pos-transactions?date=
// ═══════════════════════════════════════════════════════════════
router.delete('/', protect, requireSupervisor, async (req, res) => {
  try {
    const date = req.query.date || todayGT()
    const [result] = await sequelize.query(
      `DELETE FROM pos_transactions WHERE transaction_date = ?`, { replacements: [date] }
    )
    res.json({ success: true, message: `Transacciones del ${date} eliminadas`, deleted: result.affectedRows })
  } catch (err) {
    console.error('pos-transactions DELETE error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/pos-transactions/recipes?product=Gringa
//  Listar recetas de un producto
// ═══════════════════════════════════════════════════════════════
router.get('/recipes', async (req, res) => {
  try {
    const { product } = req.query
    const where = product
      ? `WHERE LOWER(r.product_name) = LOWER(?) AND r.is_active = 1`
      : `WHERE r.is_active = 1`
    const replacements = product ? [product] : []

    const [recipes] = await sequelize.query(
      `SELECT r.id, r.product_name, r.quantity_used, r.unit, r.notes,
              i.id as inventory_item_id, i.name as inventory_item_name, i.unit as item_unit, i.quantity as current_stock
       FROM product_recipes r
       JOIN inventory_items i ON i.id = r.inventory_item_id
       ${where}
       ORDER BY r.product_name ASC`,
      { replacements }
    )
    res.json({ success: true, data: recipes })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/pos-transactions/recipes/all-products
//  Lista todos los nombres de productos que tienen receta
// ═══════════════════════════════════════════════════════════════
router.get('/recipes/all-products', async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT DISTINCT product_name FROM product_recipes WHERE is_active = 1 ORDER BY product_name ASC`
    )
    res.json({ success: true, data: rows.map(r => r.product_name) })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/pos-transactions/recipes
//  Crear receta — soporta un ingrediente o múltiples a la vez
//  Single:   { product_name, inventory_item_id, quantity_used, unit, notes }
//  Multiple: { product_name, ingredients: [{ inventory_item_id, quantity_used, unit, notes }] }
// ═══════════════════════════════════════════════════════════════
router.post('/recipes', async (req, res) => {
  try {
    const { product_name, inventory_item_id, quantity_used, unit, notes, ingredients } = req.body

    if (!product_name) {
      return res.status(400).json({ success: false, message: 'product_name requerido' })
    }

    const name = product_name.trim()

    // Modo múltiple: array de ingredientes en un solo request
    if (Array.isArray(ingredients) && ingredients.length > 0) {
      const inserted = []
      for (const ing of ingredients) {
        if (!ing.inventory_item_id || !ing.quantity_used) continue
        const [result] = await sequelize.query(
          `INSERT INTO product_recipes (product_name, inventory_item_id, quantity_used, unit, notes)
           VALUES (?, ?, ?, ?, ?)`,
          { replacements: [name, ing.inventory_item_id, parseFloat(ing.quantity_used), ing.unit || 'unidades', ing.notes || null] }
        )
        inserted.push(result)
      }
      return res.status(201).json({ success: true, message: `${inserted.length} ingredientes guardados` })
    }

    // Modo single: un solo ingrediente
    if (!inventory_item_id || !quantity_used) {
      return res.status(400).json({ success: false, message: 'inventory_item_id y quantity_used requeridos' })
    }
    const [result] = await sequelize.query(
      `INSERT INTO product_recipes (product_name, inventory_item_id, quantity_used, unit, notes)
       VALUES (?, ?, ?, ?, ?)`,
      { replacements: [name, inventory_item_id, parseFloat(quantity_used), unit || 'unidades', notes || null] }
    )
    const [[newRecipe]] = await sequelize.query(
      `SELECT r.id, r.product_name, r.quantity_used, r.unit, r.notes,
              i.id as inventory_item_id, i.name as inventory_item_name, i.unit as item_unit, i.quantity as current_stock
       FROM product_recipes r JOIN inventory_items i ON i.id = r.inventory_item_id
       WHERE r.id = ?`,
      { replacements: [result] }
    )
    res.status(201).json({ success: true, data: newRecipe, message: 'Receta creada' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  DELETE /api/pos-transactions/recipes/:id
// ═══════════════════════════════════════════════════════════════
router.delete('/recipes/:id', async (req, res) => {
  try {
    await sequelize.query(
      `UPDATE product_recipes SET is_active = 0 WHERE id = ?`, { replacements: [req.params.id] }
    )
    res.json({ success: true, message: 'Receta eliminada' })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router