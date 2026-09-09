const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')

// ═══════════════════════════════════════════════════════════════
//  POST /api/tickets
//  Crea un ticket (cuenta sin mesa) — registro básico.
// ═══════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    const { name, peopleCount, userName } = req.body

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Falta el nombre del ticket' })
    }

    const [insertId] = await sequelize.query(
      `INSERT INTO tickets (name, status, total, people_count, user_name)
       VALUES (?, 'open', 0, ?, ?)`,
      { replacements: [String(name).trim(), peopleCount || 1, userName || ''] }
    )

    res.json({ success: true, message: 'Ticket creado', id: insertId })
  } catch (err) {
    console.error('tickets POST error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  PATCH /api/tickets/:id
//  Actualiza total / estado (por ejemplo al cobrar el ticket).
// ═══════════════════════════════════════════════════════════════
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { total, status, peopleCount } = req.body

    await sequelize.query(
      `UPDATE tickets
         SET total        = COALESCE(?, total),
             people_count = COALESCE(?, people_count),
             status       = COALESCE(?, status),
             closed_at    = CASE WHEN ? = 'paid' THEN NOW() ELSE closed_at END
       WHERE id = ?`,
      {
        replacements: [
          total ?? null,
          peopleCount ?? null,
          status ?? null,
          status ?? null,
          id,
        ],
      }
    )

    res.json({ success: true, message: 'Ticket actualizado' })
  } catch (err) {
    console.error('tickets PATCH error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/tickets?status=open
//  Lista los tickets (opcionalmente filtrados por estado).
// ═══════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  try {
    const { status } = req.query

    const [rows] = status
      ? await sequelize.query(
          `SELECT * FROM tickets WHERE status = ? ORDER BY created_at DESC`,
          { replacements: [status] }
        )
      : await sequelize.query(`SELECT * FROM tickets ORDER BY created_at DESC`)

    res.json({ success: true, data: rows })
  } catch (err) {
    console.error('tickets GET error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router