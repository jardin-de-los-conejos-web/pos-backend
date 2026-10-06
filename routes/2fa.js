const express = require('express')
const router = express.Router()
const speakeasy = require('speakeasy')
const QRCode = require('qrcode')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const rateLimit = require('express-rate-limit')
const { User } = require('../models')
const { protect, protectPendiente, marcarSesionVerificada } = require('../middleware/auth')
const { sequelize } = require('../config/database')

// Rate limiter para endpoints de 2FA
const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Demasiados intentos. Espera 15 minutos.' },
})

// ─── Helpers ────────────────────────────────────────────────────

async function generateRecoveryCodes() {
  const codes = []
  const hashes = []
  for (let i = 0; i < 8; i++) {
    const raw = crypto.randomBytes(6).toString('hex').toUpperCase()
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
    const hash = await bcrypt.hash(formatted, 12)
    codes.push(formatted)
    hashes.push(hash)
  }
  return { codes, hashes }
}

async function checkTOTPAttempts(userId) {
  const windowStart = new Date(Date.now() - 15 * 60 * 1000)
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) as attempts FROM totp_attempts 
     WHERE user_id = ? AND attempted_at > ? AND success = FALSE`,
    { replacements: [userId, windowStart] }
  )
  return rows[0].attempts
}

async function logTOTPAttempt(userId, success) {
  await sequelize.query(
    `INSERT INTO totp_attempts (user_id, success) VALUES (?, ?)`,
    { replacements: [userId, success] }
  )
  await sequelize.query(
    `DELETE FROM totp_attempts WHERE user_id = ? AND attempted_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    { replacements: [userId] }
  )
}

// ═══════════════════════════════════════════════════════════════
//  GET /api/auth/2fa/setup
//  Genera (o reutiliza) el QR para escanear — requiere JWT normal
//  El secret se genera UNA SOLA VEZ por usuario y se reutiliza
//  siempre, así el QR nunca cambia entre activaciones/desactivaciones.
// ═══════════════════════════════════════════════════════════════
router.get('/2fa/setup', protect, async (req, res) => {
  try {
    const userId = req.user.id

    const user = await User.findByPk(userId)
    if (!user) return res.status(404).json({ success: false, message: 'Usuario no encontrado' })
    if (user.role !== 'supervisor') return res.status(403).json({ success: false, message: 'Solo supervisores pueden activar 2FA' })
    if (user.two_factor_enabled) return res.status(400).json({ success: false, message: '2FA ya está activado' })

    // Reutilizar el secret existente si ya se generó antes (mismo QR siempre)
    const [rows] = await sequelize.query(
      `SELECT two_factor_secret FROM users WHERE id = ?`,
      { replacements: [userId] }
    )

    let secretBase32 = rows[0]?.two_factor_secret

    if (!secretBase32) {
      const secret = speakeasy.generateSecret({
        name: `El Jardín de los Conejos:${user.name}`,
        issuer: 'El Jardín de los Conejos POS',
        length: 20,
      })
      secretBase32 = secret.base32

      await sequelize.query(
        `UPDATE users SET two_factor_secret = ? WHERE id = ?`,
        { replacements: [secretBase32, userId] }
      )
    }

    const otpauthUrl = speakeasy.otpauthURL({
      secret: secretBase32,
      label: encodeURIComponent(`El Jardín de los Conejos:${user.name}`),
      issuer: 'El Jardín de los Conejos POS',
      encoding: 'base32',
      digits: 6,
      period: 30,
    })

    const qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
      width: 300,
      margin: 2,
      color: { dark: '#2C1810', light: '#FFFFFF' },
    })

    res.json({ success: true, qrCode: qrDataUrl, manualCode: secretBase32 })
  } catch (err) {
    console.error('setup2FA error:', err)
    res.status(500).json({ success: false, message: 'Error generando 2FA' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/2fa/enable
//  Confirma el código y activa 2FA — requiere JWT normal
// ═══════════════════════════════════════════════════════════════
router.post('/2fa/enable', protect, totpLimiter, async (req, res) => {
  try {
    const userId = req.user.id
    const { token } = req.body

    if (!token || !/^\d{6}$/.test(token)) {
      return res.status(400).json({ success: false, message: 'Código inválido (debe ser 6 dígitos)' })
    }

    const attempts = await checkTOTPAttempts(userId)
    if (attempts >= 5) {
      return res.status(429).json({ success: false, message: 'Demasiados intentos fallidos. Espera 15 minutos.' })
    }

    const [rows] = await sequelize.query(
      `SELECT two_factor_secret, two_factor_enabled FROM users WHERE id = ?`,
      { replacements: [userId] }
    )
    const userData = rows[0]
    if (!userData?.two_factor_secret) {
      return res.status(400).json({ success: false, message: 'Primero genera el QR' })
    }
    if (userData.two_factor_enabled) {
      return res.status(400).json({ success: false, message: '2FA ya está activado' })
    }

    const verified = speakeasy.totp.verify({
      secret: userData.two_factor_secret,
      encoding: 'base32',
      token,
      window: 1,
    })

    await logTOTPAttempt(userId, verified)

    if (!verified) {
      return res.status(400).json({ success: false, message: 'Código incorrecto. Verifica la hora de tu iPhone.' })
    }

    // Activar 2FA. El secret NO se toca — se conserva para que el QR
    // sea siempre el mismo si se vuelve a generar.
    await sequelize.query(
      `UPDATE users SET two_factor_enabled = TRUE, two_factor_confirmed_at = NOW() WHERE id = ?`,
      { replacements: [userId] }
    )

    // Generar códigos de recuperación SOLO si no existen aún
    const [existingCodes] = await sequelize.query(
      `SELECT COUNT(*) as count FROM recovery_codes WHERE user_id = ?`,
      { replacements: [userId] }
    )

    let codes = null
    if (existingCodes[0].count === 0) {
      const generated = await generateRecoveryCodes()
      codes = generated.codes
      for (const hash of generated.hashes) {
        await sequelize.query(
          `INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)`,
          { replacements: [userId, hash] }
        )
      }
    }

    res.json({
      success: true,
      message: '2FA activado correctamente',
      ...(codes ? { recoveryCodes: codes } : {}),
    })
  } catch (err) {
    console.error('enable2FA error:', err)
    res.status(500).json({ success: false, message: 'Error activando 2FA' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/2fa/verify
//  Verifica el código TOTP durante el login — usa tempToken
// ═══════════════════════════════════════════════════════════════
router.post('/2fa/verify', totpLimiter, async (req, res) => {
  try {
    const { tempToken, totpCode } = req.body

    if (!tempToken || !totpCode) {
      return res.status(400).json({ success: false, message: 'Datos incompletos' })
    }

    // Verificar el tempToken JWT
    let payload
    try {
      payload = jwt.verify(tempToken, process.env.JWT_SECRET)
      if (!payload.pending2FA) throw new Error('Token inválido')
    } catch {
      return res.status(401).json({ success: false, message: 'Sesión expirada. Inicia sesión de nuevo.' })
    }

    const userId = payload.id

    const attempts = await checkTOTPAttempts(userId)
    if (attempts >= 5) {
      return res.status(429).json({ success: false, message: 'Demasiados intentos. Espera 15 minutos.' })
    }

    const user = await User.findByPk(userId)
    if (!user || !user.two_factor_enabled) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' })
    }

    const isRecoveryCode = /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(totpCode)
    let verified = false

    if (!isRecoveryCode) {
      verified = speakeasy.totp.verify({
        secret: user.two_factor_secret,
        encoding: 'base32',
        token: totpCode,
        window: 1,
      })
    } else {
      const [recoveryCodes] = await sequelize.query(
        `SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`,
        { replacements: [userId] }
      )
      for (const rc of recoveryCodes) {
        const match = await bcrypt.compare(totpCode, rc.code_hash)
        if (match) {
          await sequelize.query(`UPDATE recovery_codes SET used_at = NOW() WHERE id = ?`, { replacements: [rc.id] })
          verified = true
          break
        }
      }
    }

    await logTOTPAttempt(userId, verified)

    if (!verified) {
      return res.status(400).json({ success: false, message: 'Código incorrecto' })
    }

    // ✅ Emitir JWT final
    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    )

    res.json({
      success: true,
      token,
      user: { id: user.id, name: user.name, role: user.role },
    })
  } catch (err) {
    console.error('verify2FA error:', err)
    res.status(500).json({ success: false, message: 'Error verificando código' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/2fa/disable
//  Desactiva 2FA — requiere PIN + código TOTP
//  IMPORTANTE: NO borra el secret ni los códigos de recuperación,
//  para que al reactivar se use el MISMO QR.
// ═══════════════════════════════════════════════════════════════
router.post('/2fa/disable', protect, totpLimiter, async (req, res) => {
  try {
    const userId = req.user.id
    const { pin, totpCode } = req.body

    if (!pin || !totpCode) {
      return res.status(400).json({ success: false, message: 'Se requiere PIN y código TOTP' })
    }

    const user = await User.findByPk(userId)
    if (!user || !user.two_factor_enabled) {
      return res.status(400).json({ success: false, message: '2FA no está activado' })
    }

    // Verificar PIN
    const pinValid = await user.verifyPin(pin)
    if (!pinValid) {
      return res.status(401).json({ success: false, message: 'PIN incorrecto' })
    }

    // Verificar TOTP
    const totpValid = speakeasy.totp.verify({
      secret: user.two_factor_secret,
      encoding: 'base32',
      token: totpCode,
      window: 1,
    })
    if (!totpValid) {
      return res.status(400).json({ success: false, message: 'Código TOTP incorrecto' })
    }

    // Solo apagar el flag. El secret se mantiene para reactivar con el mismo QR.
    await sequelize.query(
      `UPDATE users SET two_factor_enabled = FALSE, two_factor_confirmed_at = NULL WHERE id = ?`,
      { replacements: [userId] }
    )

    res.json({ success: true, message: '2FA desactivado correctamente' })
  } catch (err) {
    console.error('disable2FA error:', err)
    res.status(500).json({ success: false, message: 'Error desactivando 2FA' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  POST /api/auth/2fa/verify-login
//  Verifica TOTP después del login con PIN — requiere JWT temporal
// ═══════════════════════════════════════════════════════════════
router.post('/2fa/verify-login', protectPendiente, totpLimiter, async (req, res) => {
  try {
    const userId = req.user.id
    const { totpCode } = req.body

    if (!totpCode || !/^\d{6}$/.test(totpCode)) {
      return res.status(400).json({ success: false, message: 'Código inválido' })
    }

    const attempts = await checkTOTPAttempts(userId)
    if (attempts >= 5) {
      return res.status(429).json({ success: false, message: 'Demasiados intentos. Espera 15 minutos.' })
    }

    const [rows] = await sequelize.query(
      'SELECT two_factor_secret FROM users WHERE id = ? AND two_factor_enabled = TRUE',
      { replacements: [userId] }
    )
    if (!rows[0]?.two_factor_secret) {
      return res.status(400).json({ success: false, message: '2FA no está activo' })
    }

    const verified = speakeasy.totp.verify({
      secret: rows[0].two_factor_secret,
      encoding: 'base32',
      token: totpCode,
      window: 2,
    })

    await logTOTPAttempt(userId, verified)

    if (!verified) {
      return res.status(400).json({ success: false, message: 'Código incorrecto' })
    }

    // Desde aquí el token con el que inició sesión ya funciona en toda la API
    await marcarSesionVerificada(req.user.jti, userId)

    res.json({ success: true })
  } catch (err) {
    console.error('verify-login error:', err)
    res.status(500).json({ success: false, message: 'Error verificando código' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  GET /api/auth/2fa/status
//  Consulta si el usuario tiene 2FA activo
// ═══════════════════════════════════════════════════════════════
router.get('/2fa/status', protect, async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      'SELECT two_factor_enabled FROM users WHERE id = ?',
      { replacements: [req.user.id] }
    )
    res.json({ success: true, enabled: !!rows[0]?.two_factor_enabled })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error consultando estado 2FA' })
  }
})

module.exports = router