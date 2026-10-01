// ═══════════════════════════════════════════════════════════════════════════
//  Smoothie (solo backend, para no subir otra versión de la app)
//
//  1. Al arrancar el servidor se asegura de que exista el producto "Smoothie"
//     en la categoría Bebidas, con precio 0 (la app pide el precio a mano y
//     pregunta "Con pajilla / Sin pajilla") y con su foto.
//
//  2. Al cobrar, por cada Smoothie vendido:
//       · descuenta 1 Tapadera
//       · si dice "Con pajilla": descuenta 1 Pajilla de smoothie y devuelve la
//         Pajilla normal que la app ya había descontado al mandar la orden.
//
//     Las versiones nuevas de la app ya hacen esto ellas mismas: sus notas
//     traen "(smoothie)" y en ese caso aquí no se toca nada (no hay doble
//     descuento).
// ═══════════════════════════════════════════════════════════════════════════
const { sequelize } = require('../config/database')

const IMAGEN_SMOOTHIE =
  'https://images.pexels.com/photos/28117065/pexels-photo-28117065/free-photo-of-strawberry.jpeg?auto=compress&cs=tinysrgb&w=800&h=800&fit=crop'

const NOMBRES = {
  tapadera: ['tapadera', 'tapaderas'],
  pajillaSmoothie: [
    'pajillas smoothie', 'pajilla smoothie', 'pajillas smothie', 'pajilla smothie',
    'pajilla de smoothie', 'pajillas de smoothie',
  ],
  pajilla: ['pajilla', 'pajillas'],
}

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
}

// ── 1. Producto ─────────────────────────────────────────────────────────────
async function asegurarProducto() {
  try {
    const [existentes] = await sequelize.query(
      `SELECT id, image_url, is_active FROM products WHERE LOWER(TRIM(name)) = 'smoothie' LIMIT 1`
    )

    if (existentes.length) {
      const p = existentes[0]
      if (!p.image_url || !p.is_active) {
        await sequelize.query(
          `UPDATE products SET image_url = COALESCE(NULLIF(image_url, ''), ?), is_active = 1, updated_at = NOW() WHERE id = ?`,
          { replacements: [IMAGEN_SMOOTHIE, p.id] }
        )
        console.log('🥤 Smoothie: producto actualizado (foto / activo)')
      }
      return
    }

    const [categorias] = await sequelize.query(
      `SELECT id FROM categories WHERE LOWER(name) LIKE '%bebida%' ORDER BY is_active DESC, id ASC LIMIT 1`
    )
    if (!categorias.length) {
      console.log('⚠️ Smoothie: no encontré la categoría Bebidas, no se creó el producto')
      return
    }

    // id_key es único: solo se usa si nadie más lo tiene
    const [conClave] = await sequelize.query(`SELECT id FROM products WHERE id_key = 'smoothie' LIMIT 1`)
    const idKey = conClave.length ? null : 'smoothie'

    await sequelize.query(
      `INSERT INTO products (id_key, name, price, image_url, category_id, is_available, is_active, created_at, updated_at)
       VALUES (?, 'Smoothie', 0, ?, ?, 1, 1, NOW(), NOW())`,
      { replacements: [idKey, IMAGEN_SMOOTHIE, categorias[0].id] }
    )
    console.log('🥤 Smoothie: producto creado en Bebidas')
  } catch (err) {
    console.error('⚠️ Smoothie: no se pudo asegurar el producto:', err.message)
  }
}

// ── 2. Insumos al cobrar ────────────────────────────────────────────────────
async function buscarInsumo(nombres) {
  const [exactos] = await sequelize.query(
    `SELECT id, name, quantity FROM inventory_items
     WHERE is_active = 1 AND LOWER(TRIM(name)) IN (?) ORDER BY id ASC LIMIT 1`,
    { replacements: [nombres] }
  )
  return exactos[0] || null
}

async function mover(nombres, cantidad, motivo) {
  // cantidad > 0 descuenta, cantidad < 0 devuelve
  const item = await buscarInsumo(nombres)
  if (!item) {
    console.log(`⚠️ Smoothie: no encontré "${nombres[0]}" en inventario`)
    return
  }
  const actual = parseFloat(item.quantity) || 0
  const nuevo = Math.max(0, actual - cantidad)

  await sequelize.query(
    `UPDATE inventory_items SET quantity = ?, updated_at = NOW() WHERE id = ?`,
    { replacements: [nuevo, item.id] }
  )
  await sequelize.query(
    `INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name, created_at)
     VALUES (?, ?, ?, ?, 'App iOS', NOW())`,
    { replacements: [item.id, cantidad > 0 ? 'salida' : 'entrada', Math.abs(cantidad), motivo] }
  )
  console.log(`📦 Smoothie: ${item.name} ${actual} → ${nuevo}`)
}

async function descontarInsumos(orderItems) {
  try {
    for (const item of orderItems || []) {
      const nombre = normalizar(item.product_name)
      if (!nombre.includes('smoothie') && !nombre.includes('smothie')) continue

      const notas = normalizar(item.notes)
      // Las versiones nuevas de la app ya descuentan todo (sus notas traen "(smoothie)")
      if (notas.includes('(smoothie)') || notas.includes('pajilla de smoothie')) continue

      const vasos = Number(item.quantity || 1)
      if (vasos <= 0) continue

      await mover(NOMBRES.tapadera, vasos, `Venta: ${vasos}x Smoothie (tapadera)`)

      if (notas.includes('con pajilla')) {
        await mover(NOMBRES.pajillaSmoothie, vasos, `Venta: ${vasos}x Smoothie (pajilla de smoothie)`)
        // La app descontó una pajilla normal al mandar la orden: se devuelve
        await mover(NOMBRES.pajilla, -vasos, `Smoothie: se usó pajilla de smoothie, no normal`)
      }
    }
  } catch (err) {
    console.error('⚠️ Smoothie: error descontando insumos (pago guardado igual):', err.message)
  }
}

module.exports = { asegurarProducto, descontarInsumos, IMAGEN_SMOOTHIE }
