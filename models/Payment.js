const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Payment = sequelize.define('Payment', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  payment_number: {
    type: DataTypes.STRING(20),
    allowNull: false,
    unique: true,
  },
  method: {
    type: DataTypes.ENUM('cash', 'card', 'transfer', 'mixed'),
    allowNull: false,
    defaultValue: 'cash',
  },
  amount_paid: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  change_given: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  tip_amount: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  // Para pagos mixtos (efectivo + tarjeta)
  cash_amount: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  card_amount: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  transfer_amount: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  status: {
    type: DataTypes.ENUM('pending', 'completed', 'refunded', 'cancelled'),
    defaultValue: 'completed',
  },
  reference: {
    type: DataTypes.STRING(100), // Referencia de tarjeta / transferencia
    allowNull: true,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  paid_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'payments',
  hooks: {
    beforeCreate: async (payment, options) => {
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
      const Payment = require('./Payment');
      // Por el id más alto, no por el conteo: si se borran filas, el conteo repetía números
      // y el segundo cobro fallaba por número de pago duplicado.
      const ultimo = (await Payment.max('id', { transaction: options && options.transaction })) || 0;
      payment.payment_number = `PAY-${dateStr}-${String(ultimo + 1).padStart(4, '0')}`;
    },
  },
});

module.exports = Payment;
