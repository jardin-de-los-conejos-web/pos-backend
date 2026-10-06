const express = require('express');
const router = express.Router();
const { getUsers, createUser, updateUser, deleteUser } = require('../controllers/userController');
const { protect, requireSupervisor } = require('../middleware/auth');

// La lista (solo nombre y rol) es pública porque la pantalla de login la necesita.
// Crear, cambiar o borrar usuarios solo lo puede hacer un supervisor con sesión iniciada.
router.get('/', getUsers);
router.post('/', protect, requireSupervisor, createUser);
router.put('/:id', protect, requireSupervisor, updateUser);
router.delete('/:id', protect, requireSupervisor, deleteUser);

module.exports = router;