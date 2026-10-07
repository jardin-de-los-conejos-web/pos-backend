const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const OrderItem = sequelize.define('OrderItem', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  order_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // Puede ir vacío: los productos personalizados de la app (Envío, porciones, licuados con
  // notas...) no tienen producto en el menú. La columna en la base de datos ya acepta NULL;
  // el modelo no, y por eso "Agregar items" a una orden abierta fallaba con
  // "OrderItem.product_id cannot be null" (al crear la orden no fallaba porque bulkCreate no valida).
  product_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  product_name: {
    type: DataTypes.STRING(150), // snapshot del nombre al momento de la orden
    allowNull: false,
  },
  unit_price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    validate: { min: 1 },
  },
  subtotal: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  notes: {
    type: DataTypes.STRING(300),
    allowNull: true, // ej: "sin cebolla", "extra picante"
  },
  status: {
    type: DataTypes.ENUM('pending', 'preparing', 'ready', 'served', 'cancelled'),
    defaultValue: 'pending',
  },
  discount_amount: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
}, {
  tableName: 'order_items',
  hooks: {
    beforeCreate: (item) => {
      item.subtotal = parseFloat(item.unit_price) * item.quantity - parseFloat(item.discount_amount || 0);
    },
    beforeUpdate: (item) => {
      item.subtotal = parseFloat(item.unit_price) * item.quantity - parseFloat(item.discount_amount || 0);
    },
  },
});

module.exports = OrderItem;
