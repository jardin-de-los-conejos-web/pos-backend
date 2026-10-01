// ═══════════════════════════════════════════════════════════════════════════
//  Historial de transacciones (app iOS → Estadísticas → Historial)
//
//  GET /api/historial?date=YYYY-MM-DD
//  Devuelve todas las órdenes de ese día (hora de Guatemala) con:
//    número de orden, número de cocina, mesa/ticket, hora, estado, total,
//    forma de pago y lo que se pidió (producto, cantidad, precio, notas).
//  Más un resumen del día (órdenes, cobrado, efectivo, tarjeta, transferencia).
//
//  Archivo nuevo: no toca nada del POS web.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')

function todayGT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

const num = v => Number(v || 0)

router.get('/', async (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayGT()

    // Guatemala es UTC-6 todo el año: el día va de las 06:00 UTC a las 06:00 UTC del día siguiente.
    const desde = new Date(`${date}T06:00:00Z`)
    const hasta = new Date(desde.getTime() + 24 * 60 * 60 * 1000)

    const [ordenes] = await sequelize.query(
      `SELECT o.id, o.order_number, o.status, o.customer_name, o.total, o.notes,
              o.created_at, o.closed_at,
              t.name AS table_name, t.number AS table_number,
              cn.cocina_number
       FROM orders o
       LEFT JOIN tables t ON t.id = o.table_id
       LEFT JOIN cocina_order_numbers cn ON cn.order_id = o.id
       WHERE o.created_at >= ? AND o.created_at < ?
       ORDER BY o.created_at DESC`,
      { replacements: [desde, hasta] }
    )

    const ids = ordenes.map(o => o.id)
    let items = [], pagos = []
    if (ids.length) {
      ;[items] = await sequelize.query(
        `SELECT oi.order_id, COALESCE(oi.product_name, p.name, 'Producto') AS name,
                oi.quantity, oi.unit_price, oi.subtotal, oi.notes
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id IN (?)
         ORDER BY oi.id ASC`,
        { replacements: [ids] }
      )
      ;[pagos] = await sequelize.query(
        `SELECT order_id, method, amount_paid, cash_amount, card_amount, transfer_amount,
                tip_amount, status, COALESCE(paid_at, created_at) AS paid_at
         FROM payments
         WHERE order_id IN (?) AND (status IS NULL OR status <> 'refunded')
         ORDER BY id ASC`,
        { replacements: [ids] }
      )
    }

    const resumen = { ordenes: ordenes.length, cobradas: 0, abiertas: 0, total: 0, efectivo: 0, tarjeta: 0, transferencia: 0 }

    const data = ordenes.map(o => {
      const pagosOrden = pagos.filter(p => p.order_id === o.id)
      let efectivo = 0, tarjeta = 0, transferencia = 0
      for (const p of pagosOrden) {
        const monto = num(p.amount_paid)
        if (p.method === 'cash') efectivo += monto
        else if (p.method === 'card') tarjeta += monto
        else if (p.method === 'transfer') transferencia += monto
        else { // mixed u otro
          efectivo += num(p.cash_amount); tarjeta += num(p.card_amount); transferencia += num(p.transfer_amount)
        }
      }
      const cobrado = efectivo + tarjeta + transferencia
      if (o.status === 'paid' || pagosOrden.length) {
        resumen.cobradas += 1
        resumen.total += cobrado
        resumen.efectivo += efectivo
        resumen.tarjeta += tarjeta
        resumen.transferencia += transferencia
      } else if (o.status !== 'cancelled') {
        resumen.abiertas += 1
      }

      const metodos = []
      if (efectivo > 0) metodos.push('Efectivo')
      if (tarjeta > 0) metodos.push('Tarjeta')
      if (transferencia > 0) metodos.push('Transferencia')

      return {
        id: o.id,
        order_number: o.order_number,
        cocina_number: o.cocina_number || null,
        mesa: o.table_name || (o.table_number ? `Mesa ${o.table_number}` : null) || o.customer_name || 'Sin mesa',
        status: o.status,
        total: num(o.total),
        cobrado,
        metodo: metodos.join(' + ') || null,
        efectivo, tarjeta, transferencia,
        created_at: o.created_at,
        paid_at: pagosOrden.length ? pagosOrden[pagosOrden.length - 1].paid_at : null,
        items: items.filter(i => i.order_id === o.id).map(i => ({
          name: i.name,
          quantity: num(i.quantity),
          unit_price: num(i.unit_price),
          subtotal: num(i.subtotal),
          notes: i.notes || null,
        })),
      }
    })

    for (const k of ['total', 'efectivo', 'tarjeta', 'transferencia']) {
      resumen[k] = Math.round(resumen[k] * 100) / 100
    }

    res.json({ success: true, date, resumen, data })
  } catch (err) {
    console.error('historial GET error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router
