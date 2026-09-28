// ═══════════════════════════════════════════════════════════════════════════
//  Notificaciones push (Apple APNs) para avisos de STOCK BAJO
//
//  Los iPads registran su "token" en /api/devices/register. Cuando un producto
//  del inventario llega o baja de su mínimo, el servidor le manda un aviso a
//  todos los iPads, aunque la app esté cerrada.
//
//  Avisa UNA sola vez por producto: se anota en `low_stock_alerts` y no vuelve
//  a avisar hasta que ese producto se reabastezca (quede arriba del mínimo).
//
//  Variables en Railway:
//    APNS_KEY        contenido completo del archivo AuthKey_XXXX.p8
//    APNS_KEY_ID     el Key ID (10 caracteres)
//    APNS_TEAM_ID    el Team ID de Apple Developer
//    APNS_BUNDLE_ID  (opcional) por defecto com.estuardo.JardinDeLosConejos
//
//  No usa librerías nuevas: http2 y jsonwebtoken (que ya estaba instalada).
// ═══════════════════════════════════════════════════════════════════════════
const http2 = require('http2')
const jwt = require('jsonwebtoken')
const { sequelize } = require('../config/database')

const BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.estuardo.JardinDeLosConejos'
const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
}

function configurado() {
  return Boolean(process.env.APNS_KEY && process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID)
}

// La llave puede venir pegada con saltos de línea reales o como "\n"
function llavePrivada() {
  return (process.env.APNS_KEY || '').replace(/\\n/g, '\n').trim()
}

// Apple pide un token firmado; sirve hasta 1 hora, se renueva cada 45 min
let tokenCache = { valor: null, creado: 0 }
function tokenApple() {
  const ahora = Math.floor(Date.now() / 1000)
  if (tokenCache.valor && ahora - tokenCache.creado < 45 * 60) return tokenCache.valor
  const valor = jwt.sign({ iss: process.env.APNS_TEAM_ID, iat: ahora }, llavePrivada(), {
    algorithm: 'ES256',
    header: { alg: 'ES256', kid: process.env.APNS_KEY_ID },
  })
  tokenCache = { valor, creado: ahora }
  return valor
}

// ── Tablas (se crean solas la primera vez) ──────────────────────────────────
let tablasListas = false
async function asegurarTablas() {
  if (tablasListas) return
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS device_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token VARCHAR(200) NOT NULL UNIQUE,
      environment VARCHAR(20) NOT NULL DEFAULT 'production',
      user_name VARCHAR(100) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`)
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS low_stock_alerts (
      item_id INT PRIMARY KEY,
      notified_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`)
  tablasListas = true
}

// ── Registrar un iPad ───────────────────────────────────────────────────────
async function registrarDispositivo({ token, environment, userName }) {
  await asegurarTablas()
  const env = environment === 'sandbox' ? 'sandbox' : 'production'
  await sequelize.query(
    `INSERT INTO device_tokens (token, environment, user_name, is_active)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE environment = VALUES(environment),
                             user_name = COALESCE(VALUES(user_name), user_name),
                             is_active = 1`,
    { replacements: [token, env, userName || null] }
  )
}

// ── Mandar a un iPad ────────────────────────────────────────────────────────
function enviarUno(cliente, token, payload) {
  return new Promise((resolve) => {
    const req = cliente.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${tokenApple()}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    })
    let status = 0
    let cuerpo = ''
    req.on('response', (h) => { status = h[':status'] })
    req.on('data', (d) => { cuerpo += d })
    req.on('end', () => resolve({ status, cuerpo }))
    req.on('error', (e) => resolve({ status: 0, cuerpo: e.message }))
    req.setTimeout(10000, () => { req.close(); resolve({ status: 0, cuerpo: 'timeout' }) })
    req.end(JSON.stringify(payload))
  })
}

// ── Mandar a todos los iPads ────────────────────────────────────────────────
async function enviarATodos(titulo, mensaje) {
  if (!configurado()) {
    console.log('ℹ️ Push sin configurar (faltan APNS_KEY / APNS_KEY_ID / APNS_TEAM_ID)')
    return { enviados: 0, fallidos: 0 }
  }
  await asegurarTablas()
  const [dispositivos] = await sequelize.query(
    `SELECT token, environment FROM device_tokens WHERE is_active = 1`
  )
  if (dispositivos.length === 0) return { enviados: 0, fallidos: 0 }

  const payload = { aps: { alert: { title: titulo, body: mensaje }, sound: 'default' } }
  let enviados = 0
  let fallidos = 0

  for (const env of ['production', 'sandbox']) {
    const lista = dispositivos.filter((d) => d.environment === env)
    if (lista.length === 0) continue

    const cliente = http2.connect(HOSTS[env])
    cliente.on('error', (e) => console.error('⚠️ APNs conexión:', e.message))
    try {
      for (const d of lista) {
        const r = await enviarUno(cliente, d.token, payload)
        if (r.status === 200) {
          enviados++
        } else {
          fallidos++
          console.error(`⚠️ APNs ${r.status} (${env}):`, r.cuerpo)
          // El iPad ya no existe o el token no sirve → se desactiva
          if (r.status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(r.cuerpo)) {
            await sequelize.query(`UPDATE device_tokens SET is_active = 0 WHERE token = ?`,
              { replacements: [d.token] })
          }
        }
      }
    } finally {
      cliente.close()
    }
  }
  console.log(`📲 Push "${titulo}": ${enviados} enviados, ${fallidos} fallidos`)
  return { enviados, fallidos }
}

// ── Revisar el inventario y avisar lo que quedó en stock bajo ──────────────
let revisando = false
async function revisarStockBajo() {
  if (revisando) return
  revisando = true
  try {
    await asegurarTablas()

    // Lo que ya se reabasteció deja de estar "avisado", para avisar la próxima vez
    await sequelize.query(`
      DELETE a FROM low_stock_alerts a
      LEFT JOIN inventory_items i ON i.id = a.item_id
      WHERE i.id IS NULL OR i.is_active = 0 OR i.min_stock <= 0 OR i.quantity > i.min_stock`)

    // Productos en stock bajo que todavía no se avisaron
    const [nuevos] = await sequelize.query(`
      SELECT i.id, i.name, i.quantity, i.unit, i.min_stock
      FROM inventory_items i
      LEFT JOIN low_stock_alerts a ON a.item_id = i.id
      WHERE i.is_active = 1 AND i.min_stock > 0 AND i.quantity <= i.min_stock AND a.item_id IS NULL
      ORDER BY i.name`)
    if (nuevos.length === 0) return

    const num = (v) => { const n = Number(v); return Number.isInteger(n) ? String(n) : String(+n.toFixed(2)) }
    let titulo
    let mensaje
    if (nuevos.length === 1) {
      const p = nuevos[0]
      titulo = '⚠️ Stock bajo'
      mensaje = `${p.name}: quedan ${num(p.quantity)} ${p.unit} (mínimo ${num(p.min_stock)}). Conviene reabastecer.`
    } else {
      titulo = `⚠️ ${nuevos.length} productos en stock bajo`
      mensaje = nuevos.slice(0, 6).map((p) => `${p.name} (${num(p.quantity)} ${p.unit})`).join(', ')
        + (nuevos.length > 6 ? '…' : '')
    }

    const r = await enviarATodos(titulo, mensaje)
    // Solo se marcan como avisados si el aviso sí salió (o si no hay iPads registrados todavía no se marca)
    if (r.enviados > 0) {
      for (const p of nuevos) {
        await sequelize.query(`INSERT IGNORE INTO low_stock_alerts (item_id) VALUES (?)`,
          { replacements: [p.id] })
      }
    }
  } catch (e) {
    console.error('⚠️ Error revisando stock bajo:', e.message)
  } finally {
    revisando = false
  }
}

// Se llama después de cualquier cambio de inventario; no frena la respuesta
function revisarEnSegundoPlano() {
  setImmediate(() => { revisarStockBajo() })
}

// Revisión cada 5 minutos (cubre también las ventas del POS web)
function iniciarRevisionPeriodica() {
  setInterval(revisarStockBajo, 5 * 60 * 1000)
  setTimeout(revisarStockBajo, 30 * 1000)
}

module.exports = {
  configurado,
  registrarDispositivo,
  enviarATodos,
  revisarStockBajo,
  revisarEnSegundoPlano,
  iniciarRevisionPeriodica,
}
