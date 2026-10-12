const { sequelize } = require('../config/database');
const DailySummary = require('../models/DailySummary')(sequelize);

function todayGT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(date + 'T00:00:00Z'))
      || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) {
    const error = new Error('Fecha inválida; usa YYYY-MM-DD');
    error.status = 400;
    throw error;
  }
  return date;
}

async function saveDailySummary(date = todayGT(), transaction) {
  validateDate(date);
  // La misma fuente y fecha local que estadísticas y cierres de caja.
  const [rows] = await sequelize.query(`SELECT
    COUNT(*) AS total_transactions,
    COALESCE(SUM(amount), 0) AS total_revenue,
    COALESCE(SUM(CASE WHEN method = 'efectivo' THEN amount ELSE 0 END), 0) AS cash_total,
    COALESCE(SUM(CASE WHEN method = 'tarjeta' THEN amount ELSE 0 END), 0) AS card_total,
    COALESCE(SUM(CASE WHEN method = 'transferencia' THEN amount ELSE 0 END), 0) AS transfer_total
    FROM pos_transactions WHERE transaction_date = ?`, { replacements: [date], transaction });
  const row = rows[0];
  const data = { date };
  for (const key of ['total_transactions', 'total_revenue', 'cash_total', 'card_total', 'transfer_total']) {
    data[key] = Number(row[key]);
  }
  data.avg_ticket = data.total_transactions ? Number((data.total_revenue / data.total_transactions).toFixed(2)) : 0;
  await DailySummary.upsert(data, { transaction });
  return data;
}

module.exports = { DailySummary, todayGT, validateDate, saveDailySummary };
