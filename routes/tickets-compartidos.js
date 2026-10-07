// ═══════════════════════════════════════════════════════════════════════════
//  Tickets compartidos entre todos los iPads
//
//  Hasta ahora cada ticket (y cada "Para llevar") vivía solo en el iPad que lo creó.
//  Aquí queda registrado en el servidor para que todos los iPads lo vean:
//
//    GET    /api/tickets-compartidos            Lista los tickets abiertos con lo que ya se envió
//    PUT    /api/tickets-compartidos/:clientId  Crea o actualiza un ticket (nombre, personas, orden, pagos parciales)
//    DELETE /api/tickets-compartidos/:clientId  Lo borra; NO deja si tiene dinero por pagar
//
//  `clientId` es el id con que el iPad creó el ticket (un número negativo, único).
//  Los productos NO se guardan aquí: salen de la orden del ticket (order_items), que ya es del servidor.
//  Lo que está solo en el carrito de un iPad (sin enviar) sigue siendo de ese iPad.
//  Tabla nueva: no toca la tabla `tickets` que ya existe.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')

const num = v => Number(v || 0)
const r2 = v => Math.round(v * 100) / 100

let tablaLista = false
async function asegurarTabla() {
  if (tablaLista) return
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS tickets_compartidos (
       id INT AUTO_INCREMENT PRIMARY KEY,
       client_id BIGINT NOT NULL,
       name VARCHAR(200) NOT NULL,
       people_count INT NOT NULL DEFAULT 1,
       user_name VARCHAR(100) NULL,
       order_id INT NULL,
       paid_people VARCHAR(100) NULL,
       pagos_json TEXT NULL,
       status VARCHAR(10) NOT NULL DEFAULT 'open',
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       UNIQUE KEY uq_client (client_id),
       INDEX idx_status (status)
     )`
  )
  tablaLista = true
}

/** Productos y total de la orden de un ticket, solo si la orden sigue abierta. */
async function productosDeOrden(orderId) {
  const [[orden]] = await sequelize.query(
    `SELECT id, status FROM orders o WHERE o.id = ?`, { replacements: [orderId] }
  )
  if (!orden || ['paid', 'cancelled'].includes(orden.status)) return null
  const [items] = await sequelize.query(
    `SELECT id, product_id, product_name, quantity, unit_price, subtotal, notes
     FROM order_items WHERE order_id = ? AND (status IS NULL OR status <> 'cancelled') ORDER BY id`,
    { replacements: [orderId] }
  )
  return items
}

// ── Lista de tickets abiertos ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    await asegurarTabla()
    const [filas] = await sequelize.query(
      `SELECT * FROM tickets_compartidos WHERE status = 'open' ORDER BY client_id ASC`
    )

    const tickets = []
    for (const t of filas) {
      let items = [], orderAbierta = false
      const orderId = t.order_id || null
      if (orderId) {
        const productos = await productosDeOrden(orderId)
        // Orden cobrada o cancelada: orderAbierta=false y sin productos (el ticket queda vacío,
        // listo para otro pedido). El iPad usa orderId para saber que esa orden ya se cerró.
        if (productos) { orderAbierta = true; items = productos }
      }
      let pagos = []
      try { pagos = JSON.parse(t.pagos_json || '[]') } catch { pagos = [] }
      tickets.push({
        clientId: Number(t.client_id),
        name: t.name,
        peopleCount: t.people_count,
        userName: t.user_name,
        orderId,
        orderAbierta,
        items: items.map(i => ({
          id: i.id, productId: i.product_id, name: i.product_name,
          quantity: num(i.quantity), unitPrice: num(i.unit_price), subtotal: num(i.subtotal), notes: i.notes,
        })),
        total: r2(items.reduce((s, i) => s + num(i.subtotal), 0)),
        paidPeople: (t.paid_people || '').split(',').filter(Boolean).map(Number),
        pagos,
        updatedAt: t.updated_at,
      })
    }
    res.json({ success: true, tickets })
  } catch (err) {
    console.error('tickets-compartidos GET error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ── Crear / actualizar ──────────────────────────────────────────────────────
router.put('/:clientId', async (req, res) => {
  try {
    await asegurarTabla()
    const clientId = Number(req.params.clientId)
    if (!Number.isInteger(clientId)) return res.status(400).json({ success: false, message: 'clientId inválido' })
    const b = req.body || {}

    const [[existente]] = await sequelize.query(
      `SELECT * FROM tickets_compartidos WHERE client_id = ?`, { replacements: [clientId] }
    )
    // Alguien lo borró: no se resucita, el iPad lo quita de su lista
    if (existente && existente.status === 'deleted') return res.json({ success: true, deleted: true })

    const paid = Array.isArray(b.paidPeople) ? b.paidPeople.map(Number).filter(Number.isFinite).join(',') : null
    const pagos = Array.isArray(b.pagos)
      ? JSON.stringify(b.pagos.map(p => ({ method: String(p.method), amount: r2(num(p.amount)) })))
      : null

    if (!existente) {
      const nombre = String(b.name || '').trim()
      if (!nombre) return res.status(400).json({ success: false, message: 'Falta el nombre del ticket' })
      await sequelize.query(
        `INSERT INTO tickets_compartidos (client_id, name, people_count, user_name, order_id, paid_people, pagos_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        { replacements: [clientId, nombre.slice(0, 200), Math.max(1, num(b.peopleCount) || 1), b.userName || null,
          b.orderId || null, paid, pagos] }
      )
      return res.json({ success: true, created: true })
    }

    const sets = [], vals = []
    const poner = (col, v) => { sets.push(`${col} = ?`); vals.push(v) }
    if (typeof b.name === 'string' && b.name.trim()) poner('name', b.name.trim().slice(0, 200))
    if (b.peopleCount != null) poner('people_count', Math.max(1, num(b.peopleCount) || 1))
    if (b.clearOrder === true) poner('order_id', null)
    else if (b.orderId) poner('order_id', Number(b.orderId))
    if (paid !== null) poner('paid_people', paid)
    if (pagos !== null) poner('pagos_json', pagos)
    if (sets.length) {
      await sequelize.query(`UPDATE tickets_compartidos SET ${sets.join(', ')} WHERE client_id = ?`,
        { replacements: [...vals, clientId] })
    }
    res.json({ success: true, created: false })
  } catch (err) {
    console.error('tickets-compartidos PUT error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ── Borrar (no con dinero por pagar) ────────────────────────────────────────
router.delete('/:clientId', async (req, res) => {
  try {
    await asegurarTabla()
    const clientId = Number(req.params.clientId)
    const [[t]] = await sequelize.query(
      `SELECT * FROM tickets_compartidos WHERE client_id = ?`, { replacements: [clientId] }
    )
    if (!t) return res.json({ success: true, message: 'No existía' })

    if (t.order_id) {
      const productos = await productosDeOrden(t.order_id)
      const pendiente = r2((productos || []).reduce((s, i) => s + num(i.subtotal), 0))
      if (productos && pendiente > 0.009) {
        return res.status(409).json({
          success: false,
          message: `Este ticket tiene Q${pendiente.toFixed(2)} por pagar. Cóbralo o cancela la orden.`,
        })
      }
    }
    await sequelize.query(`UPDATE tickets_compartidos SET status = 'deleted' WHERE client_id = ?`, { replacements: [clientId] })
    res.json({ success: true, message: 'Ticket borrado' })
  } catch (err) {
    console.error('tickets-compartidos DELETE error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router
