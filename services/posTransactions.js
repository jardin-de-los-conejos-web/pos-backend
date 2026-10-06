// ═══════════════════════════════════════════════════════════════════════════
//  Filas de pos_transactions (lo que alimenta el cierre de caja y las estadísticas)
//
//  Antes cada fila NO decía de qué orden venía, y al eliminar una orden había que adivinarla por
//  método, monto y hora. Ahora cada fila guarda `order_id` (columna nueva, opcional).
//  La columna se agrega sola la primera vez; si por permisos no se pudiera, todo sigue
//  funcionando como antes (se guarda la fila sin order_id).
// ═══════════════════════════════════════════════════════════════════════════
const { sequelize } = require('../config/database')

let promesaColumna = null

/** true si pos_transactions tiene la columna order_id (la crea si falta). */
function tieneColumnaOrderId() {
  if (!promesaColumna) {
    promesaColumna = (async () => {
      try {
        const [c] = await sequelize.query(
          `SELECT 1 FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_transactions' AND COLUMN_NAME = 'order_id' LIMIT 1`
        )
        if (!c.length) {
          await sequelize.query(`ALTER TABLE pos_transactions ADD COLUMN order_id INT NULL, ADD INDEX idx_pos_order (order_id)`)
          console.log('✅ pos_transactions.order_id creada')
        }
        return true
      } catch (e) {
        console.error('⚠️ pos_transactions.order_id no disponible, se sigue sin ella:', e.message)
        return false
      }
    })()
  }
  return promesaColumna
}

/** Guarda una fila del cierre. `creado` (Date) es opcional; sin él se usa la hora del servidor. */
async function insertarTransaccion({ fecha, mesa = 0, persona = 1, metodo, monto, items, usuario, orderId = null, creado = null }) {
  const cols = ['transaction_date', 'table_number', 'person', 'method', 'amount', 'items', 'user_name']
  const vals = [fecha, mesa, persona, metodo, monto, typeof items === 'string' ? items : JSON.stringify(items), usuario]
  if (await tieneColumnaOrderId()) { cols.push('order_id'); vals.push(orderId) }

  cols.push('created_at')
  let marcas = vals.map(() => '?').join(', ')
  if (creado) { vals.push(creado); marcas += ', ?' } else { marcas += ', NOW()' }

  await sequelize.query(
    `INSERT INTO pos_transactions (${cols.join(', ')}) VALUES (${marcas})`,
    { replacements: vals }
  )
}

module.exports = { tieneColumnaOrderId, insertarTransaccion }
