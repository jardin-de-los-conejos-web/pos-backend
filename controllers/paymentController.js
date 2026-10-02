const { Payment, Order, OrderItem, Table, sequelize } = require('../models');


// ── Conversión de pesos entre la unidad de la receta y la del inventario ──
const GRAMOS_POR = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 }
function unidadPeso(u) {
  const t = String(u || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '')
  if (t === 'g' || t === 'gr' || t === 'grs' || t.startsWith('gramo')) return 'g'
  if (t === 'kg' || t.startsWith('kilo')) return 'kg'
  if (t === 'lb' || t === 'lbs' || t.startsWith('libra')) return 'lb'
  if (t === 'oz' || t.startsWith('onza')) return 'oz'
  return null
}
function convertirPeso(cantidad, deUnidad, aUnidad) {
  const de = unidadPeso(deUnidad), a = unidadPeso(aUnidad)
  if (!de || !a || de === a) return cantidad
  return cantidad * GRAMOS_POR[de] / GRAMOS_POR[a]
}

const processPayment = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { order_id, method, amount_paid, tip_amount, cash_amount, card_amount, transfer_amount, reference, notes } = req.body;

    const order = await Order.findByPk(order_id, { transaction: t });
    if (!order) { await t.rollback(); return res.status(404).json({ success: false, message: 'Orden no encontrada' }); }
    if (order.status === 'paid') { await t.rollback(); return res.status(400).json({ success: false, message: 'La orden ya fue pagada' }); }
    if (order.status === 'cancelled') { await t.rollback(); return res.status(400).json({ success: false, message: 'La orden fue cancelada' }); }

    const total = parseFloat(order.total);
    const paid = parseFloat(amount_paid);
    if (paid < total) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: `Monto insuficiente. Total: ${total}, Pagado: ${paid}`,
      });
    }

    const change = parseFloat((paid - total).toFixed(2));

    // Generar numero de pago
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const paymentCount = await Payment.count();
    const payment_number = 'PAY-' + dateStr + '-' + String(paymentCount + 1).padStart(4, '0');

    const payment = await Payment.create({
      payment_number,
      order_id,
      method,
      amount_paid: paid,
      change_given: change,
      tip_amount: parseFloat(tip_amount || 0),
      cash_amount: parseFloat(cash_amount || 0),
      card_amount: parseFloat(card_amount || 0),
      transfer_amount: parseFloat(transfer_amount || 0),
      reference: reference || null,
      notes: notes || null,
      status: 'completed',
      paid_at: new Date(),
    }, { transaction: t });

    // Marcar orden como pagada
    await order.update({ status: 'paid', closed_at: new Date() }, { transaction: t });

    // Liberar la mesa
    if (order.table_id) {
      await Table.update({ status: 'available' }, { where: { id: order.table_id }, transaction: t });
    }

    await t.commit();

    // ── Insertar en pos_transactions para que aparezca en el reporte web ──
    try {
      // Obtener items de la orden para guardarlos en pos_transactions
      const orderItems = await OrderItem.findAll({ where: { order_id } })

      // Fecha en Guatemala (UTC-6)
      const nowGT = new Date(Date.now() - 6 * 60 * 60 * 1000)
      const dateGT = nowGT.toISOString().slice(0, 10)

      const items = orderItems.map(i => ({
        name:     i.product_name,
        category: i.category || 'otros',
        quantity: i.quantity,
        price:    parseFloat(i.unit_price || 0),
      }))

      // Determinar método principal para pos_transactions
      const methodMap = { cash: 'efectivo', card: 'tarjeta', transfer: 'transferencia' }
      const posMeth = methodMap[method] || method || 'efectivo'

      const { sequelize: sq } = require('../models')
      await sq.query(
      `INSERT INTO pos_transactions
        (transaction_date, table_number, person, method, amount, items, user_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
          { replacements: [dateGT, 0, 1, posMeth, total, JSON.stringify(items), 'App iOS'] }
        )
    } catch (syncErr) {
      // No romper el pago si falla la sincronización
      console.error('pos_transactions sync error:', syncErr.message)
    }

    // ── Descontar ingredientes del inventario según recetas ──
    try {
      const orderItems = await OrderItem.findAll({ where: { order_id } })
      // Lo que ya se descontó al ENVIAR la orden (services/recetasAlEnviar.js) no se repite
      const yaDescontados = await require('../services/recetasAlEnviar').yaDescontados(order_id)

      for (const item of orderItems) {
        if (yaDescontados.has(item.id)) continue
        const productName = (item.product_name || '').trim()
        const qtySold = Number(item.quantity || 1)
        if (!productName || qtySold <= 0) continue

        const { sequelize: sq } = require('../models')

        const [recipes] = await sq.query(
          `SELECT r.inventory_item_id, r.quantity_used, r.unit as recipe_unit, i.unit as item_unit,
                  i.name as item_name, i.quantity as current_qty
           FROM product_recipes r
           JOIN inventory_items i ON i.id = r.inventory_item_id
           WHERE LOWER(r.product_name) = LOWER(?) AND r.is_active = 1 AND i.is_active = 1`,
          { replacements: [productName] }
        )

        for (const recipe of recipes) {
          // Si la receta quedó en otra unidad de peso que el inventario (ej. receta en
          // libras y la fruta ahora en gramos), se convierte para no descontar mal.
          const toDeduct = convertirPeso(parseFloat(recipe.quantity_used), recipe.recipe_unit, recipe.item_unit) * qtySold
          const newQty   = Math.max(0, parseFloat(recipe.current_qty) - toDeduct)

          await sq.query(
            `UPDATE inventory_items SET quantity = ?, updated_at = NOW() WHERE id = ?`,
            { replacements: [newQty, recipe.inventory_item_id] }
          )

          await sq.query(
            `INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name, created_at)
             VALUES (?, 'salida', ?, ?, 'App iOS', NOW())`,
            { replacements: [
                recipe.inventory_item_id,
                toDeduct,
                `Venta: ${qtySold}x ${productName}`
              ]
            }
          )

          console.log(`📦 Inventario: ${recipe.item_name} ${recipe.current_qty} → ${newQty} (${qtySold}x ${productName})`)
        }
      }
    } catch (invErr) {
      console.error('⚠️ Error descontando inventario (pago guardado igual):', invErr.message)
    }

    // Smoothie: tapadera y pajilla de smoothie (órdenes de la versión actual de la app)
    try {
      const itemsSmoothie = await OrderItem.findAll({ where: { order_id } })
      await require('../services/smoothie').descontarInsumos(itemsSmoothie)
    } catch (smErr) {
      console.error('⚠️ Smoothie:', smErr.message)
    }

    // Avisa a los iPads (push) si algo quedó en stock bajo después de la venta
    require('../services/push').revisarEnSegundoPlano()

    const fullPayment = await Payment.findByPk(payment.id, {
      include: [{ model: Order, as: 'order' }],
    });

    res.status(201).json({
      success: true,
      data: fullPayment,
      message: 'Pago procesado exitosamente',
      change: change,
    });
  } catch (error) {
    await t.rollback();
    res.status(500).json({ success: false, message: error.message });
  }
};

const getPayments = async (req, res) => {
  try {
    const { date, method, status } = req.query;
    const where = {};
    if (method) where.method = method;
    if (status) where.status = status;
    if (date) {
      const { Op } = require('sequelize');
      const start = new Date(date);
      const end = new Date(date);
      end.setDate(end.getDate() + 1);
      where.paid_at = { [Op.between]: [start, end] };
    }

    const payments = await Payment.findAll({
      where,
      include: [{
        model: Order, as: 'order',
        attributes: ['id', 'order_number', 'table_id', 'customer_name', 'total'],
      }],
      order: [['paid_at', 'DESC']],
    });

    res.json({ success: true, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const getPaymentById = async (req, res) => {
  try {
    const payment = await Payment.findByPk(req.params.id, {
      include: [{
        model: Order, as: 'order',
        include: [{ model: OrderItem, as: 'items' }],
      }],
    });
    if (!payment) return res.status(404).json({ success: false, message: 'Pago no encontrado' });
    res.json({ success: true, data: payment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const refundPayment = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const payment = await Payment.findByPk(id, { transaction: t });
    if (!payment) { await t.rollback(); return res.status(404).json({ success: false, message: 'Pago no encontrado' }); }
    if (payment.status !== 'completed') { await t.rollback(); return res.status(400).json({ success: false, message: 'Solo se pueden reembolsar pagos completados' }); }

    await payment.update({ status: 'refunded', notes: notes || payment.notes }, { transaction: t });
    await Order.update({ status: 'open' }, { where: { id: payment.order_id }, transaction: t });
    await t.commit();
    res.json({ success: true, data: payment, message: 'Reembolso procesado' });
  } catch (error) {
    await t.rollback();
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { processPayment, getPayments, getPaymentById, refundPayment };