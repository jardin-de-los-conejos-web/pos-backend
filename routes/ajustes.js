// ═══════════════════════════════════════════════════════════════════════════
//  Ajustes de órdenes desde la app del iPad
//
//  POST /api/ajustes/ordenes/:id/cancelar
//    Cancela una orden que todavía NO se ha cobrado (se equivocaron al pedir).
//    Regresa al inventario las recetas que se descontaron al enviarla, marca
//    la orden como cancelada (deja de salir en cocina, historial y estadísticas)
//    y libera la mesa.
//
//  POST /api/ajustes/ordenes/:id/cambiar
//    Cambia UN producto de una orden YA cobrada por otro (ej. Fanta → Coca).
//    Regresa la receta del producto que sale, descuenta la del que entra y
//    cobra (o devuelve) solo la diferencia de precio.
//
//  Archivo nuevo: no toca el POS web.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')
const { OrderItem, Payment } = require('../models')
const recetas = require('../services/recetasAlEnviar')

const num = v => Number(v || 0)
const redondear = v => Math.round(v * 100) / 100

function todayGT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** Mueve la receta de un producto: 'entrada' la regresa, 'salida' la descuenta. */
async function moverReceta(nombre, veces, tipo, motivo, userName) {
  if (!nombre || veces <= 0) return 0
  const [rs] = await sequelize.query(
    `SELECT r.inventory_item_id, r.quantity_used, r.unit AS recipe_unit, i.unit AS item_unit, i.name AS item_name
     FROM product_recipes r
     JOIN inventory_items i ON i.id = r.inventory_item_id
     WHERE LOWER(r.product_name) = LOWER(?) AND r.is_active = 1 AND i.is_active = 1`,
    { replacements: [String(nombre).trim()] }
  )
  // Sin receta: la app descuenta los productos que se llaman igual en inventario
  // (ej. "Agua Pura"). Se hace lo mismo aquí.
  if (!rs.length) {
    const [mismos] = await sequelize.query(
      `SELECT id AS inventory_item_id, 1 AS quantity_used, unit AS recipe_unit, unit AS item_unit, name AS item_name
       FROM inventory_items WHERE LOWER(name) = LOWER(?) AND is_active = 1 LIMIT 1`,
      { replacements: [String(nombre).trim()] }
    )
    rs.push(...mismos)
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
       VALUES (?, ?, ?, ?, ?, NOW())`,
      { replacements: [r.inventory_item_id, tipo, cantidad, motivo, userName || 'App iOS'] }
    )
  }
  return rs.length
}

async function pagosDe(orderId) {
  const [rows] = await sequelize.query(
    `SELECT id FROM payments WHERE order_id = ? AND (status IS NULL OR status NOT IN ('refunded','cancelled'))`,
    { replacements: [orderId] }
  )
  return rows
}

// ── Cancelar orden (no cobrada) ──────────────────────────────────────────────
router.post('/ordenes/:id/cancelar', async (req, res) => {
  try {
    const orderId = Number(req.params.id)
    const userName = req.body?.user_name || 'App iOS'
    await recetas.asegurarTabla()

    const [[orden]] = await sequelize.query(`SELECT * FROM orders WHERE id = ?`, { replacements: [orderId] })
    if (!orden) return res.status(404).json({ success: false, message: 'Orden no encontrada' })
    if (orden.status === 'cancelled') return res.json({ success: true, message: 'La orden ya estaba cancelada' })

    if ((await pagosDe(orderId)).length) {
      return res.status(409).json({
        success: false,
        message: 'Esta orden ya tiene pagos. Para cambiar algo ya cobrado usa "Cambiar producto".',
      })
    }

    // Lo que se descontó al enviar la orden vuelve al inventario
    const [descontados] = await sequelize.query(
      `SELECT oi.id, oi.product_name, oi.quantity
       FROM order_items oi
       JOIN receta_descontada rd ON rd.order_item_id = oi.id
       WHERE oi.order_id = ?`,
      { replacements: [orderId] }
    )
    for (const it of descontados) {
      await moverReceta(it.product_name, num(it.quantity), 'entrada',
        `Orden cancelada: ${num(it.quantity)}x ${it.product_name}`, userName)
    }
    if (descontados.length) {
      await sequelize.query(
        `DELETE FROM receta_descontada WHERE order_item_id IN (?)`,
        { replacements: [descontados.map(d => d.id)] }
      )
    }

    await sequelize.query(
      `UPDATE orders SET status = 'cancelled', closed_at = NOW(), updated_at = NOW() WHERE id = ?`,
      { replacements: [orderId] }
    )
    await sequelize.query(
      `UPDATE order_items SET status = 'cancelled', updated_at = NOW() WHERE order_id = ?`,
      { replacements: [orderId] }
    )
    if (orden.table_id) {
      await sequelize.query(`UPDATE tables SET status = 'available' WHERE id = ?`, { replacements: [orden.table_id] })
    }

    res.json({ success: true, message: 'Orden cancelada', devueltos: descontados.length })
  } catch (err) {
    console.error('ajustes cancelar error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ── Cambiar un producto de una orden cobrada ─────────────────────────────────
// body: { order_item_id, product_id, product_name, price, notes?, metodo: 'efectivo'|'tarjeta'|'transferencia', user_name? }
router.post('/ordenes/:id/cambiar', async (req, res) => {
  try {
    const orderId = Number(req.params.id)
    const { order_item_id, product_id, product_name, price, notes, metodo, user_name } = req.body || {}
    const userName = user_name || 'App iOS'
    const nuevoNombre = String(product_name || '').trim()
    const nuevoPrecio = num(price)
    if (!order_item_id || !nuevoNombre || nuevoPrecio < 0) {
      return res.status(400).json({ success: false, message: 'Faltan datos del producto nuevo' })
    }
    await recetas.asegurarTabla()

    const [[orden]] = await sequelize.query(`SELECT * FROM orders WHERE id = ?`, { replacements: [orderId] })
    if (!orden) return res.status(404).json({ success: false, message: 'Orden no encontrada' })
    if (orden.status !== 'paid') {
      return res.status(409).json({ success: false, message: 'Solo se pueden cambiar productos de órdenes ya cobradas' })
    }

    const viejo = await OrderItem.findOne({ where: { id: order_item_id, order_id: orderId } })
    if (!viejo) return res.status(404).json({ success: false, message: 'Producto no encontrado en la orden' })

    const precioViejo = num(viejo.unit_price)
    const diferencia = redondear(nuevoPrecio - precioViejo)
    const fecha = todayGT()

    // 1) El producto nuevo se crea PRIMERO: si algo falla aquí, la orden queda
    //    como estaba (antes se borraba el viejo y luego fallaba el nuevo).
    const nuevo = await OrderItem.create({
      order_id: orderId,
      product_id: Number(product_id) || viejo.product_id,
      product_name: nuevoNombre,
      unit_price: nuevoPrecio,
      quantity: 1,
      subtotal: nuevoPrecio,
      discount_amount: 0,
      notes: [notes, `Cambio por ${viejo.product_name}`].filter(Boolean).join(' · ').slice(0, 300),
      status: 'served',
    })
    // Su receta se descuenta aquí abajo: que el cobro no lo vuelva a descontar
    await sequelize.query(`INSERT IGNORE INTO receta_descontada (order_item_id) VALUES (?)`, { replacements: [nuevo.id] })

    // 2) Una unidad menos del viejo
    if (num(viejo.quantity) > 1) {
      await viejo.update({ quantity: num(viejo.quantity) - 1 })
    } else {
      await sequelize.query(`DELETE FROM receta_descontada WHERE order_item_id = ?`, { replacements: [viejo.id] })
      await viejo.destroy()
    }

    await sequelize.query(
      `UPDATE orders SET total = total + ?, subtotal = subtotal + ?, updated_at = NOW() WHERE id = ?`,
      { replacements: [diferencia, diferencia, orderId] }
    )

    // Inventario: regresa 1 del que sale y descuenta 1 del que entra
    // (la orden ya está cobrada, así que su receta ya se había descontado)
    await moverReceta(viejo.product_name, 1, 'entrada', `Cambio: regresa 1x ${viejo.product_name}`, userName)
    await moverReceta(nuevoNombre, 1, 'salida', `Cambio: 1x ${nuevoNombre} (por ${viejo.product_name})`, userName)

    // 3) Dinero: se cobra la diferencia (positiva) o se devuelve (negativa)
    if (diferencia !== 0) {
      const metodoApp = ['efectivo', 'tarjeta', 'transferencia'].includes(metodo) ? metodo : 'efectivo'
      const metodoPago = { efectivo: 'cash', tarjeta: 'card', transferencia: 'transfer' }[metodoApp]
      await Payment.create({
        order_id: orderId,
        payment_number: 'TMP',
        method: metodoPago,
        amount_paid: diferencia,
        change_given: 0,
        status: 'completed',
        notes: diferencia > 0
          ? `Diferencia por cambio: ${viejo.product_name} → ${nuevoNombre}`
          : `Devolución por cambio: ${viejo.product_name} → ${nuevoNombre}`,
        paid_at: new Date(),
      })
      await sequelize.query(
        `INSERT INTO pos_transactions (transaction_date, table_number, person, method, amount, items, user_name, created_at)
         VALUES (?, 0, 1, ?, ?, ?, ?, NOW())`,
        { replacements: [fecha, metodoApp, diferencia, JSON.stringify([
          { name: nuevoNombre, category: 'otros', quantity: 1, price: nuevoPrecio },
          { name: viejo.product_name, category: 'otros', quantity: -1, price: precioViejo },
        ]), userName] }
      )
    }

    require('../services/push').revisarEnSegundoPlano()
    res.json({
      success: true,
      diferencia,
      message: diferencia > 0 ? `Cobrar Q${diferencia.toFixed(2)}`
        : diferencia < 0 ? `Devolver Q${Math.abs(diferencia).toFixed(2)}`
        : 'Cambio sin diferencia de precio',
    })
  } catch (err) {
    console.error('ajustes cambiar error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router
