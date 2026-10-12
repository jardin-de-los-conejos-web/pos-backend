const { DailySummary, todayGT, saveDailySummary } = require('../services/dailySummaries');

const closeDayAndSave = async (req, res) => {
  try {
    const data = await saveDailySummary(req.body?.date ?? todayGT());
    res.json({ success: true, data, message: 'Resumen del día guardado' });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

const getHistory = async (req, res) => {
  try {
    const data = await DailySummary.findAll({ order: [['date', 'DESC']], limit: 30 });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { closeDayAndSave, getHistory };
