const jwt = require('jsonwebtoken');
const { sequelize } = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
//  Sesiones con 2FA
//  Quien entra con PIN y tiene 2FA activo recibe un token "pendiente" (tfa:'pending').
//  Ese token NO sirve para nada hasta que verifique su código (POST /api/auth/2fa/verify-login);
//  al verificarlo se anota su jti en esta tabla y desde ahí el mismo token ya funciona.
//  Así la app no tiene que cambiar nada: sigue usando el token con el que inició sesión.
// ─────────────────────────────────────────────────────────────────────────────
let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS sesiones_2fa_verificadas (
       jti VARCHAR(64) PRIMARY KEY,
       user_id INT NOT NULL,
       verified_at DATETIME DEFAULT CURRENT_TIMESTAMP
     )`
  );
  tablaLista = true;
}

async function marcarSesionVerificada(jti, userId) {
  if (!jti) return;
  await asegurarTabla();
  await sequelize.query(
    `INSERT IGNORE INTO sesiones_2fa_verificadas (jti, user_id) VALUES (?, ?)`,
    { replacements: [jti, userId] }
  );
}

async function sesionVerificada(jti) {
  if (!jti) return false;
  await asegurarTabla();
  const [rows] = await sequelize.query(
    `SELECT 1 FROM sesiones_2fa_verificadas WHERE jti = ? LIMIT 1`,
    { replacements: [jti] }
  );
  return rows.length > 0;
}

function leerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.split(' ')[1];
}

/** Verifica el token. Con permitirPendiente=true acepta el token de 2FA sin verificar todavía. */
async function autenticar(req, res, next, permitirPendiente) {
  const token = leerToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No autorizado. Token requerido.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Token inválido o expirado.' });
  }

  if (decoded.tfa === 'pending' && !permitirPendiente) {
    let ok = false;
    try { ok = await sesionVerificada(decoded.jti); } catch (e) { ok = false; }
    if (!ok) {
      return res.status(403).json({ success: false, message: 'Falta verificar el código de 2FA.' });
    }
  }

  req.user = decoded;
  next();
}

const protect = (req, res, next) => autenticar(req, res, next, false);

/** Solo para verificar el código de 2FA justo después de iniciar sesión. */
const protectPendiente = (req, res, next) => autenticar(req, res, next, true);

const requireSupervisor = (req, res, next) => {
  if (req.user?.role !== 'supervisor') {
    return res.status(403).json({ success: false, message: 'Acceso restringido a supervisores.' });
  }
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
//  Puerta general de la API: todo exige sesión, menos lo que la app necesita antes
//  de iniciar sesión.
// ─────────────────────────────────────────────────────────────────────────────
const PUBLICAS = new Set([
  'GET /health',
  'POST /auth/login',          // iniciar sesión
  'GET /auth/users',           // lista de nombres para la pantalla de login
  'GET /users',                // idem (la app vieja la pide aquí)
  'POST /devices/register',    // el iPad registra su token de avisos al abrir la app
  'POST /auth/2fa/verify-login', // la ruta misma exige el token (aunque esté pendiente de 2FA)
]);

const puertaGeneral = (req, res, next) => {
  const ruta = (req.path || '/').replace(/\/+$/, '') || '/';
  if (PUBLICAS.has(`${req.method} ${ruta}`) || req.method === 'OPTIONS') return next();
  return protect(req, res, next);
};

module.exports = { protect, protectPendiente, requireSupervisor, puertaGeneral, marcarSesionVerificada };
