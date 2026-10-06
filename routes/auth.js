const express = require('express');
const router = express.Router();
const { login, me, getUsers } = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const rateLimit = require('express-rate-limit');

// Un PIN son solo 4 dígitos: sin límite se podría adivinar probando todos.
// Solo cuentan los intentos fallidos (los que entran bien no suman).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiados intentos fallidos. Espera 15 minutos.' },
});

router.post('/login', loginLimiter, login);
router.get('/users', getUsers);      // Para poblar la pantalla de login
router.get('/me', protect, me);      // Verificar token activo

module.exports = router;
