// ═══════════════════════════════════════════════════════════════════════════
//  Eventos (catering, fiestas, ventas fuera del restaurante)
//
//  Un evento se inicia en UN iPad (el iPad cambia a modo evento, con precios propios si se
//  eligió "precios de evento"). Aquí queda registrado en tablas SEPARADAS: las ventas del
//  evento NO crean órdenes, pagos ni pos_transactions, así que no se mezclan con el cierre
//  de caja, el historial ni "Ventas por artículo" del restaurante.
//
//    POST   /api/eventos                       Inicia un evento (supervisor)
//    GET    /api/eventos                       Lista de eventos con sus totales (supervisor)
//    GET    /api/eventos/:id                   Detalle: ventas, productos, métodos de pago, inventario
//    POST   /api/eventos/:id/ventas            Registra una venta del evento
//    DELETE /api/eventos/:id/ventas/:ventaId   Quita una venta equivocada (supervisor)
//    POST   /api/eventos/:id/cerrar            Termina el evento (supervisor)
//
//    POST   /api/eventos/web                   La PÁGINA WEB agenda un evento (pública, exige la llave
//                                              EVENTOS_WEB_KEY en el encabezado x-api-key). Avisa por
//                                              push a los supervisores.
//    GET    /api/eventos/programados/lista     Eventos agendados (calendario)
//    POST   /api/eventos/programados           Agenda un evento (supervisor)
//    PATCH  /api/eventos/programados/:id       Edita / cambia estado
//    DELETE /api/eventos/programados/:id       Borra un evento agendado
//
//  Inventario del evento (se elige al iniciarlo):
//    · "restaurante": lo que se saca del inventario del restaurante SE RESTA (cantidad escrita).
//    · "aparte":      solo se anota lo que llevan; NO se resta ni se suma nada.
//
//  Archivo nuevo, tablas nuevas: no toca nada del POS.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')
const { requireSupervisor } = require('../middleware/auth')

const num = v => Number(v || 0)
const r2 = v => Math.round(v * 100) / 100

let tablasListas = false
async function asegurarTablas() {
  if (tablasListas) return
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS eventos (
       id INT AUTO_INCREMENT PRIMARY KEY,
       nombre VARCHAR(200) NOT NULL,
       estado VARCHAR(10) NOT NULL DEFAULT 'activo',
       modo_precios VARCHAR(12) NOT NULL DEFAULT 'restaurante',
       modo_inventario VARCHAR(12) NOT NULL DEFAULT 'aparte',
       dispositivo VARCHAR(100) NULL,
       user_name VARCHAR(100) NULL,
       notas TEXT NULL,
       programado_id INT NULL,
       iniciado_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       cerrado_at DATETIME NULL,
       INDEX idx_estado (estado)
     )`
  )
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS evento_precios (
       id INT AUTO_INCREMENT PRIMARY KEY,
       evento_id INT NOT NULL,
       producto VARCHAR(200) NOT NULL,
       precio DECIMAL(10,2) NOT NULL DEFAULT 0,
       precio_restaurante DECIMAL(10,2) NOT NULL DEFAULT 0,
       INDEX idx_evento (evento_id)
     )`
  )
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS evento_ventas (
       id INT AUTO_INCREMENT PRIMARY KEY,
       evento_id INT NOT NULL,
       user_name VARCHAR(100) NULL,
       total DECIMAL(10,2) NOT NULL DEFAULT 0,
       efectivo DECIMAL(10,2) NOT NULL DEFAULT 0,
       tarjeta DECIMAL(10,2) NOT NULL DEFAULT 0,
       transferencia DECIMAL(10,2) NOT NULL DEFAULT 0,
       recibido DECIMAL(10,2) NULL,
       cambio DECIMAL(10,2) NULL,
       items_json TEXT NOT NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_evento (evento_id)
     )`
  )
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS evento_inventario (
       id INT AUTO_INCREMENT PRIMARY KEY,
       evento_id INT NOT NULL,
       tipo VARCHAR(12) NOT NULL,
       item_id INT NULL,
       nombre VARCHAR(200) NOT NULL,
       cantidad DECIMAL(12,3) NOT NULL DEFAULT 0,
       unidad VARCHAR(40) NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_evento (evento_id)
     )`
  )
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS eventos_programados (
       id INT AUTO_INCREMENT PRIMARY KEY,
       titulo VARCHAR(200) NOT NULL,
       fecha DATE NOT NULL,
       hora VARCHAR(5) NULL,
       cliente VARCHAR(200) NULL,
       telefono VARCHAR(40) NULL,
       personas INT NULL,
       notas TEXT NULL,
       estado VARCHAR(12) NOT NULL DEFAULT 'programado',
       origen VARCHAR(10) NOT NULL DEFAULT 'app',
       evento_id INT NULL,
       user_name VARCHAR(100) NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       INDEX idx_fecha (fecha)
     )`
  )
  // Para avisar una sola vez por día de los eventos de hoy (tablas viejas no la tienen)
  try { await sequelize.query(`ALTER TABLE eventos_programados ADD COLUMN recordatorio_enviado DATE NULL`) }
  catch (_) { /* ya existe */ }
  tablasListas = true
}

const usuario = req => (req.user && (req.user.name || req.user.username)) || 'App iOS'
const fechaValida = f => /^\d{4}-\d{2}-\d{2}$/.test(f || '')

// ═══════════════════════════════════════════════════════════════════════════
//  Evento agendado desde la PÁGINA WEB (no hay sesión: se protege con una llave)
//
//  La web debe llamarlo desde SU servidor (no desde el navegador) para que la llave no se vea.
//  Cuerpo: { nombre, fecha: 'YYYY-MM-DD', hora: 'HH:MM', cliente, telefono, correo, personas, notas }
// ═══════════════════════════════════════════════════════════════════════════
function hoyGT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

const intentosWeb = new Map()   // ip → { cuenta, desde }
function demasiadosIntentos(ip) {
  const ahora = Date.now()
  const reg = intentosWeb.get(ip)
  if (!reg || ahora - reg.desde > 60 * 60 * 1000) { intentosWeb.set(ip, { cuenta: 1, desde: ahora }); return false }
  reg.cuenta += 1
  return reg.cuenta > 8   // máximo 8 solicitudes por hora por dirección
}

const limpio = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)

router.post('/web', async (req, res) => {
  try {
    const llave = process.env.EVENTOS_WEB_KEY
    if (!llave) return res.status(503).json({ success: false, message: 'Las solicitudes desde la web no están configuradas.' })
    if (req.get('x-api-key') !== llave) return res.status(401).json({ success: false, message: 'No autorizado.' })
    // La web llama desde su servidor: manda la IP de la persona (solo se confía porque ya traía la llave)
    if (demasiadosIntentos(req.get('x-cliente-ip') || req.ip)) return res.status(429).json({ success: false, message: 'Demasiadas solicitudes. Intenta más tarde.' })

    const b = req.body || {}
    // Campo trampa: los bots lo llenan, las personas no lo ven
    if (limpio(b.sitio_web, 50)) return res.json({ success: true })

    await asegurarTablas()
    const titulo = limpio(b.nombre || b.titulo, 200)
    const fecha = limpio(b.fecha, 10)
    const hora = /^\d{2}:\d{2}$/.test(limpio(b.hora, 5)) ? limpio(b.hora, 5) : null
    if (!titulo || !fechaValida(fecha)) {
      return res.status(400).json({ success: false, message: 'Falta el nombre del evento o la fecha (YYYY-MM-DD).' })
    }
    if (fecha < hoyGT()) return res.status(400).json({ success: false, message: 'La fecha ya pasó.' })

    const cliente = limpio(b.cliente, 200) || null
    const telefono = limpio(b.telefono, 40) || null
    const correo = limpio(b.correo, 120)
    const personas = Math.round(num(b.personas))
    const notas = [limpio(b.notas, 500), correo ? `Correo: ${correo}` : ''].filter(Boolean).join(' · ') || null

    const [id] = await sequelize.query(
      `INSERT INTO eventos_programados (titulo, fecha, hora, cliente, telefono, personas, notas, origen, user_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'web', 'Página web')`,
      { replacements: [titulo, fecha, hora, cliente, telefono, personas > 0 && personas < 100000 ? personas : null, notas] }
    )

    // Aviso a los supervisores (si el push falla, el evento ya quedó guardado)
    try {
      const cuando = `${fecha}${hora ? ' ' + hora : ''}`
      await require('../services/push').enviarASupervisores(
        '🎉 Nuevo evento desde la web',
        `${titulo} · ${cuando}${cliente ? ' · ' + cliente : ''}`)
    } catch (e) { console.error('eventos web: push falló:', e.message) }

    res.json({ success: true, data: { id } })
  } catch (e) {
    console.error('eventos web error:', e)
    res.status(500).json({ success: false, message: 'No se pudo guardar el evento.' })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
//  Recordatorio del día: una vez por la mañana avisa a los supervisores de los eventos de HOY
// ═══════════════════════════════════════════════════════════════════════════
async function enviarRecordatorios() {
  try {
    const horaGT = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Guatemala', hour: '2-digit', hour12: false }).format(new Date()))
    if (horaGT < 8 || horaGT >= 21) return
    await asegurarTablas()
    const hoy = hoyGT()
    const [rows] = await sequelize.query(
      `SELECT id, titulo, hora, cliente FROM eventos_programados
       WHERE fecha = ? AND estado = 'programado' AND (recordatorio_enviado IS NULL OR recordatorio_enviado <> ?)
       ORDER BY hora`, { replacements: [hoy, hoy] })
    for (const e of rows) {
      await require('../services/push').enviarASupervisores(
        '🎉 Evento hoy', `${e.titulo}${e.hora ? ' · ' + e.hora : ''}${e.cliente ? ' · ' + e.cliente : ''}`)
      await sequelize.query(`UPDATE eventos_programados SET recordatorio_enviado = ? WHERE id = ?`, { replacements: [hoy, e.id] })
    }
  } catch (e) {
    console.error('eventos recordatorio error:', e.message)
  }
}
router.iniciarRecordatorios = function () {
  setInterval(enviarRecordatorios, 15 * 60 * 1000)
  setTimeout(enviarRecordatorios, 60 * 1000)
}

// ═══════════════════════════════════════════════════════════════════════════
//  Eventos programados (van ANTES de /:id para que "programados" no se tome como un id)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/programados/lista', async (req, res) => {
  try {
    await asegurarTablas()
    const desde = fechaValida(req.query.from) ? req.query.from : '1970-01-01'
    const [rows] = await sequelize.query(
      `SELECT id, titulo, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, hora, cliente, telefono, personas,
              notas, estado, origen, evento_id
       FROM eventos_programados WHERE fecha >= ? ORDER BY fecha ASC, hora ASC, id ASC`,
      { replacements: [desde] }
    )
    res.json({ success: true, data: rows })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

router.post('/programados', requireSupervisor, async (req, res) => {
  try {
    await asegurarTablas()
    const { titulo, fecha, hora, cliente, telefono, personas, notas } = req.body || {}
    if (!String(titulo || '').trim() || !fechaValida(fecha)) {
      return res.status(400).json({ success: false, message: 'Falta el nombre del evento o la fecha (YYYY-MM-DD)' })
    }
    const [id] = await sequelize.query(
      `INSERT INTO eventos_programados (titulo, fecha, hora, cliente, telefono, personas, notas, origen, user_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'app', ?)`,
      { replacements: [String(titulo).trim().slice(0, 200), fecha, hora || null, cliente || null, telefono || null,
                       personas ? Math.round(num(personas)) : null, notas || null, usuario(req)] }
    )
    res.json({ success: true, data: { id } })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

router.patch('/programados/:id', requireSupervisor, async (req, res) => {
  try {
    await asegurarTablas()
    const campos = [], valores = []
    const b = req.body || {}
    const mapa = { titulo: 'titulo', fecha: 'fecha', hora: 'hora', cliente: 'cliente', telefono: 'telefono',
                   personas: 'personas', notas: 'notas', estado: 'estado' }
    for (const [clave, columna] of Object.entries(mapa)) {
      if (b[clave] === undefined) continue
      if (clave === 'fecha' && !fechaValida(b[clave])) return res.status(400).json({ success: false, message: 'Fecha inválida' })
      if (clave === 'estado' && !['programado', 'iniciado', 'cancelado'].includes(b[clave])) {
        return res.status(400).json({ success: false, message: 'Estado inválido' })
      }
      campos.push(`${columna} = ?`); valores.push(b[clave])
    }
    if (!campos.length) return res.status(400).json({ success: false, message: 'Nada que cambiar' })
    await sequelize.query(`UPDATE eventos_programados SET ${campos.join(', ')} WHERE id = ?`,
      { replacements: [...valores, req.params.id] })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

router.delete('/programados/:id', requireSupervisor, async (req, res) => {
  try {
    await asegurarTablas()
    await sequelize.query(`DELETE FROM eventos_programados WHERE id = ?`, { replacements: [req.params.id] })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
//  Iniciar un evento
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', requireSupervisor, async (req, res) => {
  const t = await sequelize.transaction()
  try {
    await asegurarTablas()
    const b = req.body || {}
    const nombre = String(b.nombre || '').trim().slice(0, 200)
    const modoPrecios = b.modoPrecios === 'evento' ? 'evento' : 'restaurante'
    const modoInventario = b.modoInventario === 'restaurante' ? 'restaurante' : 'aparte'
    if (!nombre) { await t.rollback(); return res.status(400).json({ success: false, message: 'Falta el nombre del evento' }) }

    const [eventoId] = await sequelize.query(
      `INSERT INTO eventos (nombre, estado, modo_precios, modo_inventario, dispositivo, user_name, notas, programado_id)
       VALUES (?, 'activo', ?, ?, ?, ?, ?, ?)`,
      { replacements: [nombre, modoPrecios, modoInventario, b.dispositivo || null, usuario(req), b.notas || null,
                       b.programadoId || null], transaction: t }
    )

    // Precios del evento (solo si se eligió "precios de evento")
    if (modoPrecios === 'evento') {
      for (const p of Array.isArray(b.precios) ? b.precios : []) {
        if (!String(p.producto || '').trim()) continue
        await sequelize.query(
          `INSERT INTO evento_precios (evento_id, producto, precio, precio_restaurante) VALUES (?, ?, ?, ?)`,
          { replacements: [eventoId, String(p.producto).slice(0, 200), r2(num(p.precio)), r2(num(p.precioRestaurante))],
            transaction: t }
        )
      }
    }

    // Inventario: del restaurante (se resta) o aparte (solo se anota)
    for (const it of Array.isArray(b.inventario) ? b.inventario : []) {
      const cantidad = num(it.cantidad)
      if (!String(it.nombre || '').trim() || cantidad <= 0) continue
      const delRestaurante = modoInventario === 'restaurante' && it.itemId
      await sequelize.query(
        `INSERT INTO evento_inventario (evento_id, tipo, item_id, nombre, cantidad, unidad) VALUES (?, ?, ?, ?, ?, ?)`,
        { replacements: [eventoId, delRestaurante ? 'restaurante' : 'aparte', delRestaurante ? it.itemId : null,
                         String(it.nombre).slice(0, 200), cantidad, it.unidad || null], transaction: t }
      )
      if (delRestaurante) {
        await sequelize.query(
          `UPDATE inventory_items SET quantity = GREATEST(0, quantity - ?), updated_at = NOW() WHERE id = ?`,
          { replacements: [cantidad, it.itemId], transaction: t }
        )
        await sequelize.query(
          `INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name, created_at)
           VALUES (?, 'salida', ?, ?, ?, NOW())`,
          { replacements: [it.itemId, cantidad, `Evento: ${nombre}`, usuario(req)], transaction: t }
        )
      }
    }

    if (b.programadoId) {
      await sequelize.query(`UPDATE eventos_programados SET estado = 'iniciado', evento_id = ? WHERE id = ?`,
        { replacements: [eventoId, b.programadoId], transaction: t })
    }

    await t.commit()
    try { require('../services/push').revisarEnSegundoPlano() } catch (_) { /* avisos de stock bajo: opcional */ }
    res.json({ success: true, data: { id: eventoId } })
  } catch (e) {
    await t.rollback()
    console.error('eventos POST error:', e)
    res.status(500).json({ success: false, message: e.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
//  Registrar una venta del evento
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:id/ventas', async (req, res) => {
  try {
    await asegurarTablas()
    const [[evento]] = await sequelize.query(`SELECT id, estado FROM eventos WHERE id = ?`, { replacements: [req.params.id] })
    if (!evento) return res.status(404).json({ success: false, message: 'Evento no encontrado' })
    if (evento.estado !== 'activo') return res.status(400).json({ success: false, message: 'El evento ya terminó' })

    const b = req.body || {}
    const items = (Array.isArray(b.items) ? b.items : [])
      .map(i => ({ name: String(i.name || '').slice(0, 200), quantity: num(i.quantity), price: r2(num(i.price)),
                   notes: i.notes ? String(i.notes).slice(0, 300) : null }))
      .filter(i => i.name && i.quantity > 0)
    if (!items.length) return res.status(400).json({ success: false, message: 'La venta no tiene productos' })

    const total = r2(items.reduce((s, i) => s + i.price * i.quantity, 0))
    const tarjeta = r2(Math.max(0, num(b.tarjeta)))
    const transferencia = r2(Math.max(0, num(b.transferencia)))
    const recibidoEfectivo = r2(Math.max(0, num(b.efectivo)))
    if (r2(recibidoEfectivo + tarjeta + transferencia) + 0.01 < total) {
      return res.status(400).json({ success: false, message: 'El pago es menor al total de la venta' })
    }
    // El efectivo guardado es lo que falta para llegar al total (el vuelto no es venta)
    const efectivo = r2(Math.max(0, total - tarjeta - transferencia))
    const cambio = r2(Math.max(0, recibidoEfectivo + tarjeta + transferencia - total))

    const [ventaId] = await sequelize.query(
      `INSERT INTO evento_ventas (evento_id, user_name, total, efectivo, tarjeta, transferencia, recibido, cambio, items_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      { replacements: [evento.id, usuario(req), total, efectivo, tarjeta, transferencia,
                       recibidoEfectivo || null, cambio || null, JSON.stringify(items)] }
    )
    res.json({ success: true, data: { id: ventaId, total, efectivo, tarjeta, transferencia, cambio } })
  } catch (e) {
    console.error('eventos ventas error:', e)
    res.status(500).json({ success: false, message: e.message })
  }
})

router.delete('/:id/ventas/:ventaId', requireSupervisor, async (req, res) => {
  try {
    await asegurarTablas()
    await sequelize.query(`DELETE FROM evento_ventas WHERE id = ? AND evento_id = ?`,
      { replacements: [req.params.ventaId, req.params.id] })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

router.post('/:id/cerrar', requireSupervisor, async (req, res) => {
  try {
    await asegurarTablas()
    await sequelize.query(
      `UPDATE eventos SET estado = 'cerrado', cerrado_at = NOW() WHERE id = ? AND estado = 'activo'`,
      { replacements: [req.params.id] }
    )
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
//  Estadísticas de eventos
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', requireSupervisor, async (req, res) => {
  try {
    await asegurarTablas()
    const [rows] = await sequelize.query(
      `SELECT e.id, e.nombre, e.estado, e.modo_precios, e.modo_inventario, e.user_name, e.iniciado_at, e.cerrado_at,
              COUNT(v.id) AS ventas, COALESCE(SUM(v.total), 0) AS total,
              COALESCE(SUM(v.efectivo), 0) AS efectivo, COALESCE(SUM(v.tarjeta), 0) AS tarjeta,
              COALESCE(SUM(v.transferencia), 0) AS transferencia
       FROM eventos e LEFT JOIN evento_ventas v ON v.evento_id = e.id
       GROUP BY e.id ORDER BY e.id DESC LIMIT 200`
    )
    res.json({ success: true, data: rows.map(r => ({
      ...r, ventas: num(r.ventas), total: num(r.total), efectivo: num(r.efectivo),
      tarjeta: num(r.tarjeta), transferencia: num(r.transferencia),
    })) })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

router.get('/:id', requireSupervisor, async (req, res) => {
  try {
    await asegurarTablas()
    const [[evento]] = await sequelize.query(`SELECT * FROM eventos WHERE id = ?`, { replacements: [req.params.id] })
    if (!evento) return res.status(404).json({ success: false, message: 'Evento no encontrado' })

    const [ventas] = await sequelize.query(
      `SELECT id, user_name, total, efectivo, tarjeta, transferencia, recibido, cambio, items_json, created_at
       FROM evento_ventas WHERE evento_id = ? ORDER BY id DESC`, { replacements: [evento.id] })
    const [precios] = await sequelize.query(
      `SELECT producto, precio, precio_restaurante FROM evento_precios WHERE evento_id = ? ORDER BY producto`,
      { replacements: [evento.id] })
    const [inventario] = await sequelize.query(
      `SELECT tipo, nombre, cantidad, unidad FROM evento_inventario WHERE evento_id = ? ORDER BY id`,
      { replacements: [evento.id] })

    const resumen = { ventas: ventas.length, total: 0, efectivo: 0, tarjeta: 0, transferencia: 0 }
    const productos = new Map()
    const listaVentas = ventas.map(v => {
      let items = []
      try { items = JSON.parse(v.items_json) } catch (_) { items = [] }
      resumen.total += num(v.total); resumen.efectivo += num(v.efectivo)
      resumen.tarjeta += num(v.tarjeta); resumen.transferencia += num(v.transferencia)
      for (const i of items) {
        const p = productos.get(i.name) || { producto: i.name, cantidad: 0, total: 0 }
        p.cantidad += num(i.quantity); p.total += num(i.price) * num(i.quantity)
        productos.set(i.name, p)
      }
      return { id: v.id, user_name: v.user_name, total: num(v.total), efectivo: num(v.efectivo),
               tarjeta: num(v.tarjeta), transferencia: num(v.transferencia), created_at: v.created_at, items }
    })
    for (const k of ['total', 'efectivo', 'tarjeta', 'transferencia']) resumen[k] = r2(resumen[k])

    res.json({
      success: true,
      evento,
      resumen,
      productos: [...productos.values()].map(p => ({ ...p, total: r2(p.total) })).sort((a, b) => b.cantidad - a.cantidad),
      ventas: listaVentas,
      precios: precios.map(p => ({ producto: p.producto, precio: num(p.precio), precio_restaurante: num(p.precio_restaurante) })),
      inventario: inventario.map(i => ({ tipo: i.tipo, nombre: i.nombre, cantidad: num(i.cantidad), unidad: i.unidad })),
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

module.exports = router
