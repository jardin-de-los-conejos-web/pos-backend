const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const { User } = require('../models');

// POST /api/auth/login
// Body: { role: "supervisor"|"empleado", pin: "1234" o código TOTP de 6 dígitos }
const login = async (req, res) => {
  try {
    const { role, pin } = req.body;

    if (!role || !pin) {
      return res.status(400).json({ success: false, message: 'Role y PIN son requeridos' });
    }

    // Buscar usuarios activos con ese rol
    const users = await User.findAll({
      where: { role, is_active: true },
    });

    if (!users.length) {
      return res.status(401).json({ success: false, message: 'PIN incorrecto' });
    }

    let authenticatedUser = null;
    let entroConCodigo2FA = false;

    for (const user of users) {
      // ── Si el usuario tiene 2FA activo y el PIN tiene 6 dígitos ──
      if (user.two_factor_enabled && user.two_factor_secret && /^\d{6}$/.test(String(pin))) {
        const totpValid = speakeasy.totp.verify({
          secret: user.two_factor_secret,
          encoding: 'base32',
          token: String(pin),
          window: 1,
        });
        if (totpValid) {
          authenticatedUser = user;
          entroConCodigo2FA = true;
          break;
        }
      } else {
        // Login normal con PIN
        const valid = await user.verifyPin(pin);
        if (valid) {
          authenticatedUser = user;
          break;
        }
      }
    }

    if (!authenticatedUser) {
      return res.status(401).json({ success: false, message: 'PIN incorrecto' });
    }

    // Generar JWT
    // Con 2FA activo, entrar solo con el PIN NO basta: el token queda "pendiente"
    // hasta que se verifique el código (ver middleware/auth.js).
    const tfaPendiente = !!(authenticatedUser.two_factor_enabled && authenticatedUser.two_factor_secret && !entroConCodigo2FA);

    const token = jwt.sign(
      {
        id: authenticatedUser.id,
        name: authenticatedUser.name,
        role: authenticatedUser.role,
        ...(tfaPendiente ? { tfa: 'pending' } : {}),
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '72h', jwtid: crypto.randomUUID() }
    );

    res.json({
      success: true,
      token,
      user: {
        id: authenticatedUser.id,
        name: authenticatedUser.name,
        role: authenticatedUser.role,
        twoFactorEnabled: authenticatedUser.two_factor_enabled,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/auth/me
const me = async (req, res) => {
  res.json({ success: true, user: req.user });
};

// GET /api/auth/users
const getUsers = async (req, res) => {
  try {
    const users = await User.findAll({
      where: { is_active: true },
      attributes: ['id', 'name', 'role'],
      order: [['role', 'ASC'], ['name', 'ASC']],
    });
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { login, me, getUsers };