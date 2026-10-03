// ═══════════════════════════════════════════════════════════════════════════
//  Actividad por usuario
//
//  La app del iPad manda en cada petición el encabezado "X-Usuario" con el
//  nombre del usuario que tiene la sesión abierta. Cuando una de estas acciones
//  sale bien, se guarda quién la hizo en la tabla `actividad_usuarios`:
//
//    orden          POST /api/orders, POST /api/orders/:id/items
//    cobro          POST /api/payments
//    gasto          POST /api/pos-transactions/expenses
//    gasto_borrado  DELETE /api/pos-transactions/expenses/:id
//    cancelacion    POST /api/ajustes/ordenes/:id/cancelar, PATCH /api/orders/:id/status (cancelled)
//    cambio         POST /api/ajustes/ordenes/:id/cambiar
//
//  Archivo nuevo: no toca el POS web (el web no manda X-Usuario, así que no
//  se registra nada de él).
// ═══════════════════════════════════════════════════════════════════════════
const { sequelize } = require('../config/database')

const num = v => Number(v || 0)

let tablaLista = false
async function asegurarTabla() {
  if (tablaLista) return
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS actividad_usuarios (
       id INT AUTO_INCREMENT PRIMARY KEY,
       fecha DATE NOT NULL,
       user_name VARCHAR(100) NOT NULL,
       tipo VARCHAR(30) NOT NULL,
       order_id INT NULL,
       monto DECIMAL(10,2) DEFAULT 0,
       metodo VARCHAR(30) NULL,
       detalle VARCHAR(300) NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_fecha (fecha),
       INDEX idx_usuario (user_name)
     )`
  )
  tablaLista = true
}

function fechaGT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

function usuarioDe(req) {
  const h = req.headers['x-usuario']
  if (!h) return null
  let nombre = String(h)
  try { nombre = decodeURIComponent(nombre) } catch { /* se deja como vino */ }
  nombre = nombre.trim().slice(0, 100)
  return nombre || null
}

async function registrar({ usuario, tipo, orderId = null, monto = 0, metodo = null, detalle = null }) {
  await asegurarTabla()
  await sequelize.query(
    `INSERT INTO actividad_usuarios (fecha, user_name, tipo, order_id, monto, metodo, detalle)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    { replacements: [fechaGT(), usuario, tipo, orderId, Math.round(num(monto) * 100) / 100, metodo,
      detalle ? String(detalle).slice(0, 300) : null] }
  )
}

const METODOS = { cash: 'efectivo', card: 'tarjeta', transfer: 'transferencia', mixed: 'mixto' }

async function clasificar(req, ruta, cuerpo, usuario) {
  const b = req.body || {}
  let m

  // Orden nueva
  if (req.method === 'POST' && /^\/api\/orders\/?$/.test(ruta)) {
    const d = cuerpo?.data || {}
    const items = Array.isArray(b.items) ? b.items : []
    const detalle = items.map(i => `${num(i.quantity) || 1}x ${i.product_name || i.name || 'Producto'}`).join(', ')
    const mesa = b.table_name || b.table_number || b.customer_name || ''
    return registrar({ usuario, tipo: 'orden', orderId: d.id || null, monto: d.total,
      detalle: [mesa, detalle].filter(Boolean).join(' · ') })
  }

  // Productos agregados a una orden
  if (req.method === 'POST' && (m = ruta.match(/^\/api\/orders\/(\d+)\/items\/?$/))) {
    const cant = num(b.quantity) || 1
    return registrar({ usuario, tipo: 'orden', orderId: Number(m[1]),
      monto: num(b.unit_price) * cant, detalle: `Agregó ${cant}x ${b.product_name || 'Producto'}` })
  }

  // Orden cancelada con el estado
  if (req.method === 'PATCH' && (m = ruta.match(/^\/api\/orders\/(\d+)\/status\/?$/)) && b.status === 'cancelled') {
    return registrar({ usuario, tipo: 'cancelacion', orderId: Number(m[1]), detalle: 'Orden cancelada' })
  }

  // Cobro
  if (req.method === 'POST' && /^\/api\/payments\/?$/.test(ruta) && b.order_id) {
    const [[p]] = await sequelize.query(
      `SELECT amount_paid, change_given, method, cash_amount, card_amount, transfer_amount
       FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
      { replacements: [b.order_id] }
    )
    const monto = p ? num(p.amount_paid) - num(p.change_given) : num(b.amount_paid)
    // Pago combinado: un registro por forma de pago (el vuelto sale del efectivo)
    if ((p?.method || b.method) === 'mixed') {
      const tarjeta = num(p ? p.card_amount : b.card_amount)
      const transf = num(p ? p.transfer_amount : b.transfer_amount)
      const efectivo = Math.max(0, monto - tarjeta - transf)
      for (const [met, m2] of [['efectivo', efectivo], ['tarjeta', tarjeta], ['transferencia', transf]]) {
        if (m2 > 0) await registrar({ usuario, tipo: 'cobro', orderId: Number(b.order_id), monto: m2, metodo: met,
          detalle: 'Pago combinado' })
      }
      return
    }
    const metodo = METODOS[p?.method || b.method] || b.method || null
    return registrar({ usuario, tipo: 'cobro', orderId: Number(b.order_id), monto, metodo })
  }

  // Gastos
  if (req.method === 'POST' && /^\/api\/pos-transactions\/expenses\/?$/.test(ruta)) {
    return registrar({ usuario, tipo: 'gasto', monto: b.amount, detalle: b.description })
  }
  if (req.method === 'DELETE' && (m = ruta.match(/^\/api\/pos-transactions\/expenses\/(\d+)\/?$/))) {
    return registrar({ usuario, tipo: 'gasto_borrado', detalle: `Gasto #${m[1]} borrado` })
  }

  // Cancelar orden / cambiar producto (routes/ajustes.js)
  if (req.method === 'POST' && (m = ruta.match(/^\/api\/ajustes\/ordenes\/(\d+)\/cancelar\/?$/))) {
    return registrar({ usuario, tipo: 'cancelacion', orderId: Number(m[1]), detalle: 'Orden cancelada' })
  }
  if (req.method === 'POST' && (m = ruta.match(/^\/api\/ajustes\/ordenes\/(\d+)\/cambiar\/?$/))) {
    return registrar({ usuario, tipo: 'cambio', orderId: Number(m[1]), monto: cuerpo?.diferencia,
      metodo: b.metodo || null, detalle: `Cambio a ${b.product_name || 'otro producto'}` })
  }
}

/** Se monta en /api antes de las rutas. */
function middleware(req, res, next) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return next()
  const usuario = usuarioDe(req)
  if (!usuario) return next()

  const ruta = (req.originalUrl || '').split('?')[0]
  let cuerpo = null
  const jsonOriginal = res.json.bind(res)
  res.json = (body) => { cuerpo = body; return jsonOriginal(body) }

  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return
    clasificar(req, ruta, cuerpo, usuario).catch(err =>
      console.error('⚠️ Actividad por usuario:', err.message)
    )
  })
  next()
}

module.exports = { middleware, asegurarTabla, fechaGT }
