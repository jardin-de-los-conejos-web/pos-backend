// Registro de iPads para las notificaciones push de stock bajo
const express = require('express')
const router = express.Router()
const push = require('../services/push')

// POST /api/devices/register  { token, environment: 'production'|'sandbox', user_name }
router.post('/register', async (req, res) => {
  try {
    const { token, environment, user_name } = req.body
    if (!token || !/^[0-9a-fA-F]{32,200}$/.test(token)) {
      return res.status(400).json({ success: false, message: 'Token inválido' })
    }
    await push.registrarDispositivo({ token, environment, userName: user_name })
    res.json({ success: true, push_configured: push.configurado() })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// POST /api/devices/test  → manda un aviso de prueba a todos los iPads
router.post('/test', async (req, res) => {
  try {
    const r = await push.enviarATodos('🐇 Prueba de avisos', 'Si ves esto, las notificaciones de stock bajo ya funcionan.')
    res.json({ success: true, push_configured: push.configurado(), ...r })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

module.exports = router
