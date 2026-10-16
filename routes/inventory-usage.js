const express = require('express')
const router = express.Router()
const { sequelize } = require('../config/database')
const { protect, requireSupervisor } = require('../middleware/auth')
const { canonical, convertedQuantity, validDate, todayGT } = require('../services/inventory-usage-units')
const push = require('../services/push')

let tablePromise
function ensureTable() {
  if (!tablePromise) tablePromise = sequelize.query(`CREATE TABLE IF NOT EXISTS inventory_usage_notes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    request_id VARCHAR(36) NOT NULL UNIQUE,
    usage_date DATE NOT NULL,
    inventory_item_id INT NOT NULL,
    item_name VARCHAR(200) NOT NULL,
    input_quantity DECIMAL(16,6) NOT NULL,
    input_unit VARCHAR(40) NOT NULL,
    inventory_quantity DECIMAL(10,2) NOT NULL,
    inventory_unit VARCHAR(40) NOT NULL,
    notes VARCHAR(500) NULL,
    user_id INT NOT NULL,
    user_name VARCHAR(100) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending',
    applied_by VARCHAR(100) NULL,
    applied_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_day_status (usage_date,status)
  )`).catch(error => { tablePromise = null; throw error })
  return tablePromise
}
const error = (message, status = 400) => Object.assign(new Error(message), { status })
const present = row => ({ ...row, input_quantity:Number(row.input_quantity), inventory_quantity:Number(row.inventory_quantity) })
const replyError = (res, err) => res.status(err.status || 500).json({ success:false, message:err.status ? err.message : 'No se pudo guardar o consultar las anotaciones. Intenta de nuevo.' })

router.get('/', protect, async (req, res) => {
  try {
    const date = validDate(req.query.date || todayGT())
    await ensureTable()
    const [rows] = await sequelize.query("SELECT *, DATE_FORMAT(usage_date, '%Y-%m-%d') AS usage_date FROM inventory_usage_notes WHERE usage_date = ? ORDER BY created_at DESC, id DESC", { replacements:[date] })
    res.json({ success:true, data:rows.map(present) })
  } catch (err) { replyError(res,err) }
})

router.post('/', protect, async (req, res) => {
  try {
    const { requestId, inventoryItemId, quantity, unit, notes } = req.body
    const date = validDate(req.body.date || todayGT())
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId || '')) throw error('Identificador de anotación inválido')
    if (!Number.isSafeInteger(Number(inventoryItemId)) || Number(inventoryItemId) <= 0) throw error('Selecciona un producto')
    if (typeof unit !== 'string' || !unit.trim() || unit.length > 40) throw error('Selecciona una unidad válida')
    if (!Number.isFinite(Number(quantity)) || Number(quantity) > 9999999999) throw error('Cantidad inválida')
    const detail = String(notes || '').trim()
    if (detail.length > 500) throw error('La nota no puede superar 500 caracteres')
    await ensureTable()
    const [[item]] = await sequelize.query('SELECT * FROM inventory_items WHERE id = ? AND is_active = 1', { replacements:[inventoryItemId] })
    if (!item) throw error('El producto ya no está activo')
    const amount = convertedQuantity(quantity,unit,item.unit)
    const [, nuevas] = await sequelize.query(`INSERT IGNORE INTO inventory_usage_notes
      (request_id,usage_date,inventory_item_id,item_name,input_quantity,input_unit,inventory_quantity,inventory_unit,notes,user_id,user_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, { replacements:[requestId,date,inventoryItemId,item.name,Number(quantity),canonical(unit),amount,item.unit,detail || null,req.user.id,req.user.name || 'Empleado'] })
    const [[row]] = await sequelize.query("SELECT *, DATE_FORMAT(usage_date, '%Y-%m-%d') AS usage_date FROM inventory_usage_notes WHERE request_id = ?", { replacements:[requestId] })
    if (row.user_id !== req.user.id || Number(row.inventory_item_id) !== Number(inventoryItemId)
        || String(row.usage_date).slice(0,10) !== date || Math.abs(Number(row.input_quantity) - Number(quantity)) > 0.00001
        || canonical(row.input_unit) !== canonical(unit) || (row.notes || '') !== detail) throw error('Este identificador ya pertenece a otra anotación',409)
    // Aviso al supervisor para que lo revise (solo la primera vez: un reintento no vuelve a avisar;
    // si lo anotó un supervisor no hace falta avisarle)
    if (nuevas && req.user.role !== 'supervisor') {
      push.enviarASupervisores('📝 Consumo anotado',
        `${row.user_name} anotó ${Number(row.input_quantity)} ${row.input_unit} de ${row.item_name}. Revísalo en Anotaciones.`
      ).catch(e => console.error('⚠️ Aviso de consumo anotado:', e.message))
    }
    res.json({ success:true, data:present(row) })
  } catch (err) { replyError(res,err) }
})

router.post('/apply', protect, requireSupervisor, async (req, res) => {
  try {
    const date = validDate(req.body.date)
    if (!Array.isArray(req.body.ids)) throw error('Selecciona anotaciones válidas')
    const ids = [...new Set(req.body.ids)]
    if (!ids.length || ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw error('Selecciona anotaciones válidas')
    await ensureTable()
    const applied = await sequelize.transaction(async transaction => {
      const [rows] = await sequelize.query('SELECT * FROM inventory_usage_notes WHERE id IN (?) AND usage_date = ? ORDER BY id FOR UPDATE', { replacements:[ids,date],transaction })
      if (rows.length !== ids.length || rows.some(r => !['pending','applied'].includes(r.status))) throw error('Una anotación cambió; vuelve a revisar el día',409)
      const pending = rows.filter(r => r.status === 'pending')
      if (!pending.length) return [] // reintento: ya se aplicaron, no restar otra vez
      const itemIds = [...new Set(pending.map(r => r.inventory_item_id))].sort((a,b) => a-b)
      const [items] = await sequelize.query('SELECT * FROM inventory_items WHERE id IN (?) ORDER BY id FOR UPDATE', { replacements:[itemIds],transaction })
      const byId = new Map(items.map(i => [i.id,i]))
      const totals = new Map()
      for (const row of pending) {
        const item = byId.get(row.inventory_item_id)
        if (!item || !item.is_active) throw error('Un producto ya no está activo; revisa las anotaciones',409)
        if (canonical(item.unit) !== canonical(row.inventory_unit)) throw error('Cambió la unidad de '+item.name+'; revisa la cantidad',409)
        const cents = Math.round(Number(row.inventory_quantity)*100)
        totals.set(item.id,(totals.get(item.id) || 0)+cents)
      }
      for (const [id,cents] of totals) {
        const item = byId.get(id)
        if (Math.round(Number(item.quantity)*100) < cents) throw error('No hay existencia suficiente de '+item.name+'. No se descontó ningún producto.',409)
      }
      for (const [id,cents] of totals) {
        await sequelize.query('UPDATE inventory_items SET quantity = quantity - ?, updated_at = NOW() WHERE id = ?', { replacements:[cents/100,id],transaction })
      }
      for (const row of pending) {
        const reason = ('Anotación #'+row.id+' del '+date+'; registrada por '+row.user_name+(row.notes ? ': '+row.notes : '')).slice(0,200)
        await sequelize.query("INSERT INTO inventory_movements (item_id,type,quantity,reason,user_name,created_at) VALUES (?,'salida',?,?,?,NOW())", { replacements:[row.inventory_item_id,Number(row.inventory_quantity),reason,req.user.name || 'Supervisor'],transaction })
        await sequelize.query("UPDATE inventory_usage_notes SET status = 'applied', applied_by = ?, applied_at = NOW() WHERE id = ?", { replacements:[req.user.name || 'Supervisor',row.id],transaction })
      }
      return pending.map(r => r.id)
    })
    if (applied.length) push.revisarEnSegundoPlano()
    res.json({ success:true, data:applied, message:applied.length ? 'Consumos descontados' : 'Estas anotaciones ya se habían aplicado' })
  } catch (err) { replyError(res,err) }
})

router.delete('/:id', protect, async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isSafeInteger(id) || id <= 0) throw error('Anotación inválida')
    await ensureTable()
    await sequelize.transaction(async transaction => {
      const [[row]] = await sequelize.query('SELECT * FROM inventory_usage_notes WHERE id = ? FOR UPDATE', { replacements:[id],transaction })
      if (!row) throw error('No se encontró la anotación',404)
      if (req.user.role !== 'supervisor' && row.user_id !== req.user.id) throw error('Solo puedes cancelar tus anotaciones',403)
      if (row.status === 'cancelled') return
      if (row.status !== 'pending') throw error('Ya se descontó; no se puede cancelar desde anotaciones',409)
      await sequelize.query("UPDATE inventory_usage_notes SET status = 'cancelled' WHERE id = ?", { replacements:[id],transaction })
    })
    res.json({ success:true, message:'Anotación cancelada, sin descuento' })
  } catch (err) { replyError(res,err) }
})
module.exports = router
