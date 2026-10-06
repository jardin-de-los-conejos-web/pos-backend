const { Order, OrderItem, Product, Table, sequelize } = require('../models');

// =====================
//    MESAS
// =====================

const getTables = async (req, res) => {
  try {
    const tables = await Table.findAll({
      where: { is_active: true },
      include: [{
        model: Order,
        as: 'orders',
        where: { status: ['open', 'in_progress', 'ready', 'delivered'] },
        required: false,
        limit: 1,
        order: [['created_at', 'DESC']],
      }],
      order: [['number', 'ASC']],
    });
    res.json({ success: true, data: tables });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const createTable = async (req, res) => {
  try {
    const { number, name, capacity, section } = req.body;
    const table = await Table.create({ number, name, capacity, section });
    res.status(201).json({ success: true, data: table, message: 'Mesa creada exitosamente' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

const updateTableStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const table = await Table.findByPk(id);
    if (!table) return res.status(404).json({ success: false, message: 'Mesa no encontrada' });
    await table.update({ status });
    res.json({ success: true, data: table, message: 'Estado de mesa actualizado' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// =====================
//    ÓRDENES
// =====================

const getOrders = async (req, res) => {
  try {
    const { status, date, type } = req.query;
    const where = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (date) {
      const { Op } = require('sequelize');
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      where.created_at = { [Op.between]: [startDate, endDate] };
    }

    const orders = await Order.findAll({
      where,
      include: [
        { model: Table, as: 'table', attributes: ['id', 'number', 'name'] },
        {
          model: OrderItem, as: 'items',
          include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'image_url'] }],
        },
      ],
      order: [['created_at', 'DESC']],
    });

    res.json({ success: true, data: orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getOrderById = async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id, {
      include: [
        { model: Table, as: 'table' },
        {
          model: OrderItem, as: 'items',
          include: [{ model: Product, as: 'product' }],
        },
      ],
    });
    if (!order) return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    res.json({ success: true, data: order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const createOrder = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    // FIX 2026-09-09: la app iOS manda "table_number" y "people_count".
    // Antes solo se leían table_id / table_name / customer_count, así que la
    // orden se guardaba con table_id = NULL y en cocina salía "Sin mesa"
    // desde cualquier otro dispositivo.
    const {
      table_id,
      table_name,
      table_number,
      customer_name,
      customer_count,
      people_count,
      type,
      notes,
      items,
    } = req.body;

    if (!items || items.length === 0) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'La orden debe tener al menos un producto' });
    }

    let subtotal = 0;
    const orderItemsData = [];

    for (const item of items) {
      // Modo POS web: sin product_id, usa product_name y unit_price directamente
      if (!item.product_id) {
        const unitPrice = parseFloat(item.unit_price) || 0;
        const itemSubtotal = unitPrice * item.quantity;
        subtotal += itemSubtotal;
        orderItemsData.push({
          product_id: null,
          product_name: item.product_name || 'Producto',
          unit_price: unitPrice,
          quantity: item.quantity,
          subtotal: itemSubtotal,
          notes: item.notes || null,
        });
        continue;
      }

      // Modo app nativa: con product_id, valida contra DB
      const product = await Product.findByPk(item.product_id, { transaction: t });
      if (!product || product.is_available === false) {
        await t.rollback();
        return res.status(400).json({ success: false, message: `Producto ${item.product_id} no disponible` });
      }
      const itemSubtotal = parseFloat(product.price) * item.quantity;
      subtotal += itemSubtotal;
      orderItemsData.push({
        product_id: product.id,
        product_name: product.name,
        unit_price: product.price,
        quantity: item.quantity,
        subtotal: itemSubtotal,
        notes: item.notes || null,
      });
    }

    const tax_amount = 0;
    const total = parseFloat(subtotal.toFixed(2));

    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const orderCount = await Order.count();
    const order_number = 'ORD-' + dateStr + '-' + String(orderCount + 1).padStart(4, '0');

    // ── Resolver la mesa ──────────────────────────────────────────────
    // La referencia puede venir como table_id, table_name ("Mesa 2") o
    // table_number ("2", que es lo que manda la app iOS).
    const rawTable = table_name || table_number || null;

    let resolvedTableId = table_id || null;
    let resolvedTableName = customer_name || (rawTable != null ? String(rawTable) : null);

    if (!resolvedTableId && rawTable != null) {
      try {
        // Solo se resuelve como mesa si es un número puro ("2") o "Mesa 2".
        // Un ticket sin mesa ("Juan 2") NO debe engancharse a la Mesa 2:
        // se queda como customer_name y ya.
        const match = String(rawTable).trim().match(/^(?:mesa\s*)?(\d+)$/i);
        if (match) {
          const foundTable = await Table.findOne({
            where: { number: match[1] },
            transaction: t,
          });
          if (foundTable) {
            resolvedTableId = foundTable.id;
            if (!customer_name) {
              resolvedTableName = foundTable.name || `Mesa ${match[1]}`;
            }
          }
        }
      } catch (_) {}
    }

    const order = await Order.create({
      order_number,
      table_id: resolvedTableId,
      customer_name: resolvedTableName,
      // people_count es el nombre que usa la app iOS
      customer_count: customer_count || people_count || 1,
      type: type || 'dine_in',
      notes,
      subtotal,
      tax_amount,
      total,
      status: 'open',
    }, { transaction: t });

    const itemsWithOrderId = orderItemsData.map(item => ({ ...item, order_id: order.id }));
    await OrderItem.bulkCreate(itemsWithOrderId, { transaction: t });

    // Solo actualizar stock para items con product_id
    for (const item of items) {
      if (!item.product_id) continue;
      const product = await Product.findByPk(item.product_id, { transaction: t });
      if (product && product.stock !== null && product.stock !== undefined) {
        const newStock = Math.max(0, product.stock - item.quantity);
        await product.update({ stock: newStock }, { transaction: t });
      }
    }

    if (resolvedTableId) {
      await Table.update({ status: 'occupied' }, { where: { id: resolvedTableId }, transaction: t });
    }

    await t.commit();

    const fullOrder = await Order.findByPk(order.id, {
      include: [
        { model: Table, as: 'table' },
        { model: OrderItem, as: 'items', include: [{ model: Product, as: 'product' }] },
      ],
    });

    res.status(201).json({ success: true, data: fullOrder, message: 'Orden creada exitosamente' });
  } catch (error) {
    await t.rollback();
    res.status(500).json({ success: false, message: error.message });
  }
};

const addItemToOrder = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id: order_id } = req.params;
    const { product_id, quantity, notes } = req.body;

    const order = await Order.findByPk(order_id, { transaction: t });
    if (!order) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }
    if (['paid', 'cancelled'].includes(order.status)) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'No se puede modificar una orden cerrada' });
    }

    // Productos personalizados de la app (porciones, licuados con notas, envío...):
    // llegan sin product_id, con nombre y precio. Igual que al crear la orden, se
    // guardan tal cual. Antes aquí se rechazaban ("Producto no disponible") y la app
    // cobraba de todos modos, así que ese dinero nunca llegaba al servidor.
    if (!product_id) {
      const nombre = String(req.body.product_name || '').trim();
      const precio = parseFloat(req.body.unit_price);
      const cant = Number(quantity) || 1;
      if (!nombre || !(precio >= 0)) {
        await t.rollback();
        return res.status(400).json({ success: false, message: 'Falta el nombre o el precio del producto' });
      }
      await OrderItem.create({
        order_id,
        product_id: null,
        product_name: nombre,
        unit_price: precio,
        quantity: cant,
        subtotal: precio * cant,
        notes: notes || null,
      }, { transaction: t });

      await recalculateOrderTotals(order_id, t);
      await t.commit();

      const ordenActualizada = await Order.findByPk(order_id, {
        include: [
          { model: Table, as: 'table' },
          { model: OrderItem, as: 'items', include: [{ model: Product, as: 'product' }] },
        ],
      });
      return res.status(201).json({ success: true, data: ordenActualizada, message: 'Producto agregado a la orden' });
    }

    const product = await Product.findByPk(product_id, { transaction: t });
    // FIX: solo rechazar si explícitamente false (no si is_available es null)
    if (!product || product.is_available === false) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'Producto no disponible' });
    }

    const itemSubtotal = parseFloat(product.price) * quantity;
    const newItem = await OrderItem.create({
      order_id,
      product_id,
      product_name: product.name,
      unit_price: product.price,
      quantity,
      subtotal: itemSubtotal,
      notes: notes || null,
    }, { transaction: t });

    if (product.stock !== null && product.stock !== undefined) {
      const newStock = Math.max(0, product.stock - quantity);
      await product.update({ stock: newStock }, { transaction: t });
    }

    await recalculateOrderTotals(order_id, t);
    await t.commit();

    // Devolver la orden completa actualizada
    const updatedOrder = await Order.findByPk(order_id, {
      include: [
        { model: Table, as: 'table' },
        { model: OrderItem, as: 'items', include: [{ model: Product, as: 'product' }] },
      ],
    });

    res.status(201).json({ success: true, data: updatedOrder, message: 'Producto agregado a la orden' });
  } catch (error) {
    await t.rollback();
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateOrderItemStatus = async (req, res) => {
  try {
    const { item_id } = req.params;
    const { status } = req.body;
    const item = await OrderItem.findByPk(item_id);
    if (!item) return res.status(404).json({ success: false, message: 'Item no encontrado' });
    await item.update({ status });
    res.json({ success: true, data: item, message: 'Estado actualizado' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const updateOrderStatus = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { status } = req.body;
    const order = await Order.findByPk(id, { transaction: t });
    if (!order) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }

    const updates = { status };
    if (status === 'paid' || status === 'cancelled') {
      updates.closed_at = new Date();
      if (order.table_id) {
        await Table.update({ status: 'available' }, { where: { id: order.table_id }, transaction: t });
      }
    }

    await order.update(updates, { transaction: t });
    await t.commit();
    res.json({ success: true, data: order, message: `Orden ${status}` });
  } catch (error) {
    await t.rollback();
    res.status(500).json({ success: false, message: error.message });
  }
};

const removeItemFromOrder = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id: order_id, item_id } = req.params;
    const item = await OrderItem.findOne({ where: { id: item_id, order_id }, transaction: t });
    if (!item) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Item no encontrado' });
    }

    const product = await Product.findByPk(item.product_id, { transaction: t });
    if (product && product.stock !== null && product.stock !== undefined) {
      await product.update({ stock: product.stock + item.quantity }, { transaction: t });
    }

    await item.update({ status: 'cancelled' }, { transaction: t });
    await recalculateOrderTotals(order_id, t);
    await t.commit();
    res.json({ success: true, message: 'Item removido de la orden' });
  } catch (error) {
    await t.rollback();
    res.status(500).json({ success: false, message: error.message });
  }
};

// Helper: Recalcular totales de una orden
const recalculateOrderTotals = async (order_id, t) => {
  const items = await OrderItem.findAll({
    where: { order_id, status: { [require('sequelize').Op.ne]: 'cancelled' } },
    transaction: t,
  });
  const subtotal = items.reduce((sum, item) => sum + parseFloat(item.subtotal), 0);
  const tax_amount = 0;
  const total = parseFloat(subtotal.toFixed(2));
  await Order.update({ subtotal, tax_amount, total }, { where: { id: order_id }, transaction: t });
};

module.exports = {
  getTables, createTable, updateTableStatus,
  getOrders, getOrderById, createOrder,
  addItemToOrder, updateOrderItemStatus, updateOrderStatus, removeItemFromOrder,
};