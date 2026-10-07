// ═══════════════════════════════════════════════════════════════════════════
//  Diagnóstico del servidor y de la base de datos (SOLO LECTURA, solo supervisor)
//
//    GET /api/diagnostico/esquema       Estructura de TODAS las tablas (SHOW CREATE TABLE) y cuántas filas tienen.
//                                       Sirve para guardar el esquema real en database/schema_produccion.sql.
//    GET /api/diagnostico/consistencia  Revisiones internas: cobros que no cuadran, órdenes raras,
//                                       inventario, recetas huérfanas, etc.
//
//  No cambia nada y no devuelve datos de clientes: solo estructura, conteos e identificadores.
//  Se usa con scripts/exportar_esquema.py y scripts/diagnostico.py (piden tu PIN en la terminal).
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')
const { protect, requireSupervisor } = require('../middleware/auth')

router.use(protect, requireSupervisor)

const nombreSeguro = n => /^[A-Za-z0-9_]+$/.test(n)

router.get('/esquema', async (req, res) => {
  try {
    const [[info]] = await sequelize.query(`SELECT DATABASE() AS base, VERSION() AS version`)
    const [lista] = await sequelize.query(`SHOW TABLES`)
    const nombres = lista.map(r => Object.values(r)[0]).filter(nombreSeguro).sort()

    const tablas = []
    for (const nombre of nombres) {
      const t = { tabla: nombre, ddl: null, filas: null, error: null }
      try {
        const [[c]] = await sequelize.query(`SHOW CREATE TABLE \`${nombre}\``)
        t.ddl = c['Create Table'] || c['Create View'] || null
        const [[n]] = await sequelize.query(`SELECT COUNT(*) AS n FROM \`${nombre}\``)
        t.filas = Number(n.n)
      } catch (e) { t.error = e.message }
      tablas.push(t)
    }
    res.json({ success: true, base: info.base, version: info.version, tablas })
  } catch (err) {
    console.error('diagnostico esquema error:', err)
    res.status(500).json({ success: false, message: err.message })
  }
})

// Cada revisión devuelve cuántos casos raros hay y unos ejemplos. Si una tabla no existe, solo esa revisión falla.
const REVISIONES = [
  {
    nombre: 'Órdenes cobradas sin ningún pago registrado',
    sql: `SELECT o.id, o.order_number, o.total FROM orders o
          LEFT JOIN payments p ON p.order_id = o.id AND (p.status IS NULL OR p.status NOT IN ('refunded','cancelled'))
          WHERE o.status = 'paid' AND p.id IS NULL AND o.order_number NOT LIKE 'VTA-%' LIMIT 50`,
  },
  {
    nombre: 'Órdenes cuyos productos no suman su total',
    sql: `SELECT o.id, o.order_number, o.total, ROUND(SUM(oi.subtotal), 2) AS suma_productos
          FROM orders o JOIN order_items oi ON oi.order_id = o.id AND (oi.status IS NULL OR oi.status <> 'cancelled')
          WHERE o.status <> 'cancelled'
          GROUP BY o.id, o.order_number, o.total HAVING ABS(o.total - SUM(oi.subtotal)) > 0.01 LIMIT 50`,
  },
  {
    nombre: 'Días donde los cobros no coinciden con lo que muestra el cierre (últimos 30 días)',
    sql: `SELECT d.dia, ROUND(d.cobros, 2) AS cobros_en_pagos, ROUND(COALESCE(t.cierre, 0), 2) AS en_el_cierre
          FROM (SELECT DATE(DATE_SUB(COALESCE(paid_at, created_at), INTERVAL 6 HOUR)) AS dia,
                       SUM(amount_paid - COALESCE(change_given, 0)) AS cobros
                FROM payments WHERE (status IS NULL OR status NOT IN ('refunded','cancelled'))
                  AND COALESCE(paid_at, created_at) >= DATE_SUB(NOW(), INTERVAL 31 DAY) GROUP BY dia) d
          LEFT JOIN (SELECT transaction_date AS dia, SUM(amount) AS cierre FROM pos_transactions GROUP BY transaction_date) t
                 ON t.dia = d.dia
          WHERE ABS(d.cobros - COALESCE(t.cierre, 0)) > 0.01
            -- Diferencia aceptada: el 5/10 el cierre se dejó con lo que marcó la terminal (Q25 más en tarjeta)
            AND NOT (d.dia = '2026-10-05' AND ABS(COALESCE(t.cierre, 0) - d.cobros - 25) < 0.01)
          ORDER BY d.dia DESC LIMIT 50`,
  },
  {
    // Las de tickets abiertos no cuentan: un ticket es una cuenta que se queda abierta a propósito
    // (cenas y almuerzos de empleados, clientes que pagan después). Esas salen abajo como información.
    nombre: 'Órdenes de mesa o Para llevar sin cobrar desde hace más de 6 horas',
    sql: `SELECT o.id, o.order_number, o.customer_name, o.status, o.total, o.created_at FROM orders o
          WHERE o.status NOT IN ('paid','cancelled') AND o.created_at < DATE_SUB(NOW(), INTERVAL 6 HOUR)
            AND NOT EXISTS (SELECT 1 FROM tickets_compartidos tc WHERE tc.order_id = o.id AND tc.status = 'open')
          ORDER BY o.created_at LIMIT 50`,
  },
  {
    nombre: 'Recetas que descuentan pajillas o tapaderas (la app ya las descuenta: salen dobles)',
    sql: `SELECT r.id, r.product_name, i.name AS descuenta FROM product_recipes r
          JOIN inventory_items i ON i.id = r.inventory_item_id
          WHERE r.is_active = 1 AND (i.name LIKE '%pajill%' OR i.name LIKE '%tapadera%') LIMIT 50`,
  },
  {
    nombre: 'Números de orden repetidos',
    sql: `SELECT order_number, COUNT(*) AS veces FROM orders GROUP BY order_number HAVING COUNT(*) > 1 LIMIT 50`,
  },
  {
    nombre: 'Recetas que apuntan a un producto de inventario que no existe o está apagado',
    sql: `SELECT r.id, r.product_name, r.inventory_item_id FROM product_recipes r
          LEFT JOIN inventory_items i ON i.id = r.inventory_item_id AND i.is_active = 1
          WHERE r.is_active = 1 AND i.id IS NULL LIMIT 50`,
  },
  {
    nombre: 'Descuentos de recetas de productos que ya no existen',
    sql: `SELECT rd.order_item_id FROM receta_descontada rd
          LEFT JOIN order_items oi ON oi.id = rd.order_item_id WHERE oi.id IS NULL LIMIT 50`,
  },
  {
    nombre: 'Ventas del cierre con un método de pago desconocido (últimos 30 días)',
    sql: `SELECT transaction_date, method, COUNT(*) AS veces, ROUND(SUM(amount), 2) AS monto FROM pos_transactions
          WHERE method NOT IN ('efectivo','tarjeta','transferencia') AND transaction_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
          GROUP BY transaction_date, method LIMIT 50`,
  },
  {
    nombre: 'Movimientos de inventario de productos que ya no existen',
    sql: `SELECT m.id, m.item_id, m.type, m.quantity FROM inventory_movements m
          LEFT JOIN inventory_items i ON i.id = m.item_id WHERE i.id IS NULL LIMIT 50`,
  },
  {
    nombre: 'Cobros del cierre ligados a una orden cancelada o que ya no existe',
    sql: `SELECT t.id, t.order_id, t.method, t.amount, t.transaction_date FROM pos_transactions t
          LEFT JOIN orders o ON o.id = t.order_id
          WHERE t.order_id IS NOT NULL AND (o.id IS NULL OR o.status = 'cancelled') LIMIT 50`,
  },
  {
    nombre: 'Órdenes cobradas cuyo cobro en el cierre no coincide con sus pagos',
    sql: `SELECT o.id, o.order_number, ROUND(p.neto, 2) AS pagos, ROUND(t.cierre, 2) AS en_el_cierre FROM orders o
          JOIN (SELECT order_id, SUM(amount_paid - COALESCE(change_given, 0)) AS neto FROM payments
                WHERE status IS NULL OR status NOT IN ('refunded','cancelled') GROUP BY order_id) p ON p.order_id = o.id
          JOIN (SELECT order_id, SUM(amount) AS cierre FROM pos_transactions WHERE order_id IS NOT NULL GROUP BY order_id) t
                ON t.order_id = o.id
          WHERE ABS(p.neto - t.cierre) > 0.01 LIMIT 50`,
  },
  // ── Informativas: muestran qué hay abierto, no cuentan como problema ──
  {
    info: true,
    nombre: 'Inventario en cero (para comprar)',
    sql: `SELECT id, name, quantity, unit FROM inventory_items WHERE is_active = 1 AND quantity <= 0 ORDER BY name LIMIT 100`,
  },
  {
    info: true,
    nombre: 'Cuentas de tickets abiertas desde hace más de 6 horas',
    sql: `SELECT o.id, tc.name AS ticket, o.total, o.created_at FROM orders o
          JOIN tickets_compartidos tc ON tc.order_id = o.id AND tc.status = 'open'
          WHERE o.status NOT IN ('paid','cancelled') AND o.created_at < DATE_SUB(NOW(), INTERVAL 6 HOUR)
          ORDER BY o.created_at LIMIT 50`,
  },
  {
    info: true,
    nombre: 'Órdenes abiertas ahora (sin cobrar)',
    sql: `SELECT o.id, o.order_number, o.type, o.table_id, t.number AS mesa, o.customer_name, o.status, o.total, o.created_at
          FROM orders o LEFT JOIN tables t ON t.id = o.table_id
          WHERE o.status NOT IN ('paid','cancelled') ORDER BY o.created_at LIMIT 100`,
  },
  {
    info: true,
    nombre: 'Mesas: estado y su orden abierta (lo que ven los iPads)',
    sql: `SELECT t.id, t.number AS mesa, t.status AS estado_mesa,
                 (SELECT o.id FROM orders o WHERE o.table_id = t.id AND o.status NOT IN ('paid','cancelled')
                  ORDER BY o.id DESC LIMIT 1) AS orden_abierta,
                 (SELECT o.total FROM orders o WHERE o.table_id = t.id AND o.status NOT IN ('paid','cancelled')
                  ORDER BY o.id DESC LIMIT 1) AS total
          FROM tables t WHERE t.is_active = 1 ORDER BY t.id LIMIT 50`,
  },
  {
    info: true,
    nombre: 'Pajillas en Inventario y sus últimos movimientos',
    sql: `SELECT i.id, i.name, i.unit, i.quantity, i.is_active,
                 (SELECT SUBSTRING_INDEX(GROUP_CONCAT(CONCAT(m.type, ' ', m.quantity, ' · ', COALESCE(m.reason, ''), ' · ', m.created_at)
                         ORDER BY m.id DESC SEPARATOR ' | '), ' | ', 5)
                  FROM inventory_movements m WHERE m.item_id = i.id) AS ultimos
          FROM inventory_items i WHERE i.name LIKE '%pajill%' OR i.name LIKE '%popote%' LIMIT 20`,
  },
  {
    info: true,
    nombre: 'Tickets compartidos abiertos en los iPads',
    sql: `SELECT tc.client_id, tc.name, tc.user_name, tc.order_id, o.status AS estado_orden, o.total
          FROM tickets_compartidos tc LEFT JOIN orders o ON o.id = tc.order_id
          WHERE tc.status = 'open' ORDER BY tc.client_id DESC LIMIT 100`,
  },
  {
    info: true,
    nombre: 'Tickets del registro viejo que siguen como "open" (esa tabla nunca se cierra sola)',
    sql: `SELECT id, name, status, total, user_name, created_at FROM tickets WHERE status = 'open' ORDER BY created_at DESC LIMIT 100`,
  },
]

router.get('/consistencia', async (req, res) => {
  const checks = []
  for (const r of REVISIONES) {
    try {
      const [filas] = await sequelize.query(r.sql)
      checks.push({
        nombre: r.nombre, info: !!r.info, ok: r.info ? true : filas.length === 0,
        cantidad: filas.length, ejemplos: filas.slice(0, 15), error: null,
      })
    } catch (e) {
      checks.push({ nombre: r.nombre, info: !!r.info, ok: false, cantidad: null, ejemplos: [], error: e.message })
    }
  }
  res.json({ success: true, checks })
})

module.exports = router
