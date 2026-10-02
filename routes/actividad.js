// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/actividad?date=YYYY-MM-DD
//  Resumen por usuario del día (solo lo ve el supervisor en la app):
//  órdenes enviadas, cobros (efectivo / tarjeta / transferencia), gastos,
//  cancelaciones y cambios de producto. Más el detalle de cada acción.
//
//  Los gastos salen de pos_expenses (así cuadran con Gastos del día, incluso
//  los que se anotaron antes de que existiera este registro).
//  Archivo nuevo: no toca el POS web.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')
const actividad = require('../services/actividad')

const num = v => Number(v || 0)
const r2 = v => Math.round(v * 100) / 100

router.get('/', async (req, res) => {
  try {
    await actividad.asegurarTabla()
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : actividad.fechaGT()

    const [filas] = await sequelize.query(
      `SELECT id, user_name, tipo, order_id, monto, metodo, detalle, created_at
       FROM actividad_usuarios WHERE fecha = ? ORDER BY created_at DESC, id DESC`,
      { replacements: [date] }
    )
    const [gastos] = await sequelize.query(
      `SELECT id, description, amount, user_name, created_at FROM pos_expenses WHERE expense_date = ?`,
      { replacements: [date] }
    )

    const usuarios = {}
    const de = nombre => {
      const k = (nombre || 'Sin usuario').trim() || 'Sin usuario'
      if (!usuarios[k]) usuarios[k] = {
        user_name: k, ordenes: 0, total_ordenes: 0, cobros: 0, cobrado: 0,
        efectivo: 0, tarjeta: 0, transferencia: 0, gastos: 0, total_gastos: 0,
        cancelaciones: 0, cambios: 0, _ordenes: new Set(),
      }
      return usuarios[k]
    }

    for (const f of filas) {
      const u = de(f.user_name)
      const monto = num(f.monto)
      if (f.tipo === 'orden') {
        if (f.order_id) u._ordenes.add(f.order_id); else u.ordenes += 1
        u.total_ordenes += monto
      } else if (f.tipo === 'cobro' || (f.tipo === 'cambio' && monto !== 0)) {
        if (f.tipo === 'cobro') u.cobros += 1
        u.cobrado += monto
        if (f.metodo === 'tarjeta') u.tarjeta += monto
        else if (f.metodo === 'transferencia') u.transferencia += monto
        else u.efectivo += monto
      }
      if (f.tipo === 'cancelacion') u.cancelaciones += 1
      if (f.tipo === 'cambio') u.cambios += 1
    }
    for (const g of gastos) {
      const u = de(g.user_name)
      u.gastos += 1
      u.total_gastos += num(g.amount)
    }

    const lista = Object.values(usuarios).map(u => {
      u.ordenes += u._ordenes.size
      delete u._ordenes
      for (const k of ['total_ordenes', 'cobrado', 'efectivo', 'tarjeta', 'transferencia', 'total_gastos']) u[k] = r2(u[k])
      return u
    }).sort((a, b) => b.cobrado - a.cobrado || b.total_ordenes - a.total_ordenes)

    const detalle = [
      ...filas.filter(f => f.tipo !== 'gasto' && f.tipo !== 'gasto_borrado').map(f => ({
        user_name: f.user_name, tipo: f.tipo, order_id: f.order_id, monto: r2(num(f.monto)),
        metodo: f.metodo, detalle: f.detalle, created_at: f.created_at,
      })),
      ...gastos.map(g => ({
        user_name: g.user_name || 'Sin usuario', tipo: 'gasto', order_id: null, monto: r2(num(g.amount)),
        metodo: null, detalle: g.description, created_at: g.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    res.json({ success: true, date, usuarios: lista, data: detalle })
  } catch (err) {
    console.error('actividad GET error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

module.exports = router
