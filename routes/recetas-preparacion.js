// ═══════════════════════════════════════════════════════════════════════════
//  Recetas de preparación (app iOS → Anotaciones → Recetas)
//
//  Lo que se prepara en el restaurante con productos del inventario: la crema, salsas, etc.
//  Se arma la receta una vez (qué productos lleva y cuánto) y cada vez que alguien la hace
//  toca "Realicé esta receta": se descuenta del inventario lo que lleva, una vez por cada
//  vez que se hizo, y queda anotado quién la hizo y cuándo.
//
//    GET    /api/recetas-preparacion                 Recetas con sus productos
//    POST   /api/recetas-preparacion                 Crear  { name, notes, items:[{inventoryItemId, quantity, unit}] }
//    PUT    /api/recetas-preparacion/:id             Editar (supervisor o quien la creó)
//    DELETE /api/recetas-preparacion/:id             Quitar (supervisor o quien la creó)
//    POST   /api/recetas-preparacion/:id/realizar    { requestId, veces } → descuenta del inventario
//    GET    /api/recetas-preparacion/realizadas?date=YYYY-MM-DD   Lo que se preparó ese día
//    DELETE /api/recetas-preparacion/realizadas/:id  Deshacer (supervisor): regresa al inventario
//
//  Las cantidades se guardan en la unidad en que se escribieron (ej. gramos) y al realizarla se
//  pasan a la unidad del inventario (ej. libras). Si un producto no alcanza, se deja en 0 y se avisa:
//  lo que se usó de verdad no se pierde.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')
const { protect, requireSupervisor } = require('../middleware/auth')
const { canonical, convertedQuantity, validDate, todayGT } = require('../services/inventory-usage-units')
const push = require('../services/push')

let tablas
function asegurarTablas() {
  if (!tablas) {
    tablas = (async () => {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS prep_recipes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        notes VARCHAR(300) NULL,
        created_by_id INT NULL,
        created_by VARCHAR(100) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`)
      await sequelize.query(`CREATE TABLE IF NOT EXISTS prep_recipe_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        recipe_id INT NOT NULL,
        inventory_item_id INT NOT NULL,
        quantity DECIMAL(16,6) NOT NULL,
        unit VARCHAR(40) NOT NULL,
        INDEX idx_recipe (recipe_id)
      )`)
      await sequelize.query(`CREATE TABLE IF NOT EXISTS prep_recipe_runs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        request_id VARCHAR(36) NOT NULL UNIQUE,
        recipe_id INT NOT NULL,
        recipe_name VARCHAR(120) NOT NULL,
        veces DECIMAL(10,2) NOT NULL,
        run_date DATE NOT NULL,
        user_id INT NULL,
        user_name VARCHAR(100) NOT NULL,
        detalle_json TEXT NOT NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'done',
        undone_by VARCHAR(100) NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_date (run_date)
      )`)
    })().catch(e => { tablas = null; throw e })
  }
  return tablas
}

const error = (message, status = 400) => Object.assign(new Error(message), { status })
const responder = (res, err) => {
  if (!err.status) console.error('recetas-preparacion:', err)
  res.status(err.status || 500).json({ success: false, message: err.status ? err.message : 'No se pudo guardar o consultar las recetas. Intenta de nuevo.' })
}
const r2 = v => Math.round(Number(v) * 100) / 100
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

/** Revisa nombre y productos. Devuelve los productos limpios. */
async function validar(body, recipeId = null) {
  const name = String(body.name || '').trim()
  if (!name || name.length > 120) throw error('Escribe el nombre de la receta')
  const notes = String(body.notes || '').trim()
  if (notes.length > 300) throw error('La nota no puede pasar de 300 caracteres')
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 40) throw error('Agrega al menos un producto')

  const [[repetida]] = await sequelize.query(
    `SELECT id FROM prep_recipes WHERE is_active = 1 AND LOWER(name) = LOWER(?) AND id <> ?`,
    { replacements: [name, recipeId || 0] }
  )
  if (repetida) throw error('Ya existe una receta con ese nombre')

  const items = []
  const vistos = new Set()
  for (const i of body.items) {
    const id = Number(i.inventoryItemId)
    if (!Number.isSafeInteger(id) || id <= 0) throw error('Selecciona el producto de cada línea')
    if (vistos.has(id)) throw error('Un producto aparece dos veces; junta las cantidades en una sola línea')
    vistos.add(id)
    const [[item]] = await sequelize.query('SELECT * FROM inventory_items WHERE id = ? AND is_active = 1', { replacements: [id] })
    if (!item) throw error('Un producto ya no está activo en el inventario')
    const unit = String(i.unit || '').trim()
    if (!unit || unit.length > 40) throw error(`Selecciona la unidad de ${item.name}`)
    try {
      convertedQuantity(i.quantity, unit, item.unit)   // misma regla que al realizarla
    } catch (e) {
      throw error(`${item.name}: ${e.message}`)
    }
    items.push({ inventoryItemId: id, quantity: Number(i.quantity), unit: canonical(unit) })
  }
  return { name, notes: notes || null, items }
}

async function puedeCambiar(req, id) {
  const [[receta]] = await sequelize.query('SELECT * FROM prep_recipes WHERE id = ? AND is_active = 1', { replacements: [id] })
  if (!receta) throw error('No se encontró la receta', 404)
  if (req.user.role !== 'supervisor' && receta.created_by_id !== req.user.id) {
    throw error('Solo el supervisor o quien creó la receta la puede cambiar', 403)
  }
  return receta
}

// ── Lista ───────────────────────────────────────────────────────────────────
router.get('/', protect, async (req, res) => {
  try {
    await asegurarTablas()
    const [recetas] = await sequelize.query('SELECT * FROM prep_recipes WHERE is_active = 1 ORDER BY name')
    const [items] = await sequelize.query(
      `SELECT ri.*, i.name AS item_name, i.unit AS item_unit, i.quantity AS stock, i.is_active AS item_activo
       FROM prep_recipe_items ri LEFT JOIN inventory_items i ON i.id = ri.inventory_item_id ORDER BY ri.id`
    )
    const porReceta = new Map()
    for (const it of items) {
      if (!porReceta.has(it.recipe_id)) porReceta.set(it.recipe_id, [])
      porReceta.get(it.recipe_id).push({
        inventoryItemId: it.inventory_item_id, itemName: it.item_name || '(producto borrado)',
        quantity: Number(it.quantity), unit: it.unit, itemUnit: it.item_unit, stock: Number(it.stock || 0),
        activo: it.item_activo === 1,
      })
    }
    res.json({ success: true, data: recetas.map(r => ({
      id: r.id, name: r.name, notes: r.notes, createdById: r.created_by_id, createdBy: r.created_by,
      items: porReceta.get(r.id) || [],
    })) })
  } catch (err) { responder(res, err) }
})

// ── Crear / editar / quitar ─────────────────────────────────────────────────
router.post('/', protect, async (req, res) => {
  try {
    await asegurarTablas()
    const datos = await validar(req.body)
    const id = await sequelize.transaction(async transaction => {
      const [nuevo] = await sequelize.query(
        'INSERT INTO prep_recipes (name, notes, created_by_id, created_by) VALUES (?, ?, ?, ?)',
        { replacements: [datos.name, datos.notes, req.user.id || null, req.user.name || 'Usuario'], transaction }
      )
      for (const i of datos.items) {
        await sequelize.query('INSERT INTO prep_recipe_items (recipe_id, inventory_item_id, quantity, unit) VALUES (?, ?, ?, ?)',
          { replacements: [nuevo, i.inventoryItemId, i.quantity, i.unit], transaction })
      }
      return nuevo
    })
    res.json({ success: true, data: { id }, message: 'Receta guardada' })
  } catch (err) { responder(res, err) }
})

router.put('/:id', protect, async (req, res) => {
  try {
    await asegurarTablas()
    const id = Number(req.params.id)
    await puedeCambiar(req, id)
    const datos = await validar(req.body, id)
    await sequelize.transaction(async transaction => {
      await sequelize.query('UPDATE prep_recipes SET name = ?, notes = ? WHERE id = ?', { replacements: [datos.name, datos.notes, id], transaction })
      await sequelize.query('DELETE FROM prep_recipe_items WHERE recipe_id = ?', { replacements: [id], transaction })
      for (const i of datos.items) {
        await sequelize.query('INSERT INTO prep_recipe_items (recipe_id, inventory_item_id, quantity, unit) VALUES (?, ?, ?, ?)',
          { replacements: [id, i.inventoryItemId, i.quantity, i.unit], transaction })
      }
    })
    res.json({ success: true, message: 'Receta actualizada' })
  } catch (err) { responder(res, err) }
})

router.delete('/:id(\\d+)', protect, async (req, res) => {
  try {
    await asegurarTablas()
    const id = Number(req.params.id)
    await puedeCambiar(req, id)
    await sequelize.query('UPDATE prep_recipes SET is_active = 0 WHERE id = ?', { replacements: [id] })
    res.json({ success: true, message: 'Receta quitada (lo que ya se preparó queda en el historial)' })
  } catch (err) { responder(res, err) }
})

// ── Realizar: descuenta del inventario ──────────────────────────────────────
router.post('/:id(\\d+)/realizar', protect, async (req, res) => {
  try {
    await asegurarTablas()
    const id = Number(req.params.id)
    const { requestId } = req.body
    const veces = Number(req.body.veces ?? 1)
    if (!UUID.test(requestId || '')) throw error('Identificador inválido')
    if (!Number.isFinite(veces) || veces <= 0 || veces > 100) throw error('¿Cuántas veces la hiciste? (de 0.5 a 100)')
    const fecha = todayGT()

    const resultado = await sequelize.transaction(async transaction => {
      // Reintento del mismo toque (se fue el internet): no se descuenta otra vez
      const [[yaHecha]] = await sequelize.query('SELECT * FROM prep_recipe_runs WHERE request_id = ?', { replacements: [requestId], transaction })
      if (yaHecha) return { run: yaHecha, repetida: true }

      const [[receta]] = await sequelize.query('SELECT * FROM prep_recipes WHERE id = ? AND is_active = 1', { replacements: [id], transaction })
      if (!receta) throw error('No se encontró la receta', 404)
      const [lineas] = await sequelize.query('SELECT * FROM prep_recipe_items WHERE recipe_id = ? ORDER BY id', { replacements: [id], transaction })
      if (!lineas.length) throw error('La receta no tiene productos')

      const ids = lineas.map(l => l.inventory_item_id)
      const [items] = await sequelize.query('SELECT * FROM inventory_items WHERE id IN (?) ORDER BY id FOR UPDATE', { replacements: [ids], transaction })
      const porId = new Map(items.map(i => [i.id, i]))

      const detalle = []
      for (const l of lineas) {
        const item = porId.get(l.inventory_item_id)
        if (!item || !item.is_active) throw error('Un producto de la receta ya no está activo; edita la receta', 409)
        let restar
        try { restar = convertedQuantity(Number(l.quantity) * veces, l.unit, item.unit) }
        catch (e) { throw error(`${item.name}: ${e.message}. Edita la receta`, 409) }
        const antes = r2(item.quantity)
        const despues = Math.max(0, r2(antes - restar))
        detalle.push({ itemId: item.id, item: item.name, cantidad: restar, unidad: item.unit, antes, despues, falto: r2(Math.max(0, restar - antes)) })
      }

      const motivo = (`Receta "${receta.name}" x${veces} · la hizo ${req.user.name || 'Usuario'}`).slice(0, 200)
      for (const d of detalle) {
        await sequelize.query('UPDATE inventory_items SET quantity = ?, updated_at = NOW() WHERE id = ?', { replacements: [d.despues, d.itemId], transaction })
        await sequelize.query(
          "INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name, created_at) VALUES (?, 'salida', ?, ?, ?, NOW())",
          { replacements: [d.itemId, d.cantidad, motivo, req.user.name || 'Usuario'], transaction }
        )
      }
      await sequelize.query(
        `INSERT INTO prep_recipe_runs (request_id, recipe_id, recipe_name, veces, run_date, user_id, user_name, detalle_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        { replacements: [requestId, id, receta.name, veces, fecha, req.user.id || null, req.user.name || 'Usuario', JSON.stringify(detalle)], transaction }
      )
      const [[run]] = await sequelize.query('SELECT * FROM prep_recipe_runs WHERE request_id = ?', { replacements: [requestId], transaction })
      return { run, repetida: false }
    })

    if (!resultado.repetida) push.revisarEnSegundoPlano()   // avisa si algo quedó en stock bajo
    const detalle = JSON.parse(resultado.run.detalle_json || '[]')
    const faltaron = detalle.filter(d => d.falto > 0)
    res.json({
      success: true,
      data: { id: resultado.run.id, detalle },
      message: resultado.repetida ? 'Ya estaba registrada; no se descontó otra vez'
        : faltaron.length
          ? `Listo. Ojo: no alcanzaba ${faltaron.map(d => d.item).join(', ')}; quedó en 0. Revisa la existencia.`
          : 'Listo, se descontó del inventario',
    })
  } catch (err) { responder(res, err) }
})

// ── Lo que se preparó en un día ─────────────────────────────────────────────
router.get('/realizadas', protect, async (req, res) => {
  try {
    await asegurarTablas()
    const fecha = validDate(req.query.date || todayGT())
    const [filas] = await sequelize.query(
      `SELECT * FROM prep_recipe_runs WHERE run_date = ? ORDER BY created_at DESC, id DESC`, { replacements: [fecha] }
    )
    res.json({ success: true, data: filas.map(f => ({
      id: f.id, recipeId: f.recipe_id, recipeName: f.recipe_name, veces: Number(f.veces), userName: f.user_name,
      status: f.status, undoneBy: f.undone_by, createdAt: f.created_at, detalle: JSON.parse(f.detalle_json || '[]'),
    })) })
  } catch (err) { responder(res, err) }
})

// ── Deshacer (se registró por error): regresa lo descontado ─────────────────
router.delete('/realizadas/:id(\\d+)', protect, requireSupervisor, async (req, res) => {
  try {
    await asegurarTablas()
    const id = Number(req.params.id)
    await sequelize.transaction(async transaction => {
      const [[run]] = await sequelize.query('SELECT * FROM prep_recipe_runs WHERE id = ? FOR UPDATE', { replacements: [id], transaction })
      if (!run) throw error('No se encontró', 404)
      if (run.status === 'undone') return
      const motivo = (`Se deshizo receta "${run.recipe_name}" x${Number(run.veces)}`).slice(0, 200)
      for (const d of JSON.parse(run.detalle_json || '[]')) {
        // Regresa solo lo que de verdad se restó (si no alcanzaba, se restó menos)
        const restado = r2(d.antes - d.despues)
        if (restado <= 0) continue
        await sequelize.query('UPDATE inventory_items SET quantity = quantity + ?, updated_at = NOW() WHERE id = ?', { replacements: [restado, d.itemId], transaction })
        await sequelize.query(
          "INSERT INTO inventory_movements (item_id, type, quantity, reason, user_name, created_at) VALUES (?, 'entrada', ?, ?, ?, NOW())",
          { replacements: [d.itemId, restado, motivo, req.user.name || 'Supervisor'], transaction }
        )
      }
      await sequelize.query("UPDATE prep_recipe_runs SET status = 'undone', undone_by = ? WHERE id = ?", { replacements: [req.user.name || 'Supervisor', id], transaction })
    })
    res.json({ success: true, message: 'Se deshizo y regresó al inventario' })
  } catch (err) { responder(res, err) }
})

module.exports = router
