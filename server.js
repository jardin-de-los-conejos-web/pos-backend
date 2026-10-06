require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { connectDB, sequelize } = require('./config/database');
const { errorHandler, notFound } = require('./middleware/errorHandler');

// Rutas
const menuRoutes = require('./routes/menu');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const reportRoutes = require('./routes/reports');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const inventoryRoutes = require('./routes/inventory');
const tableRoutes = require('./routes/tables');
const dailySummaryRoutes = require('./routes/dailySummary');
const twoFactorRoutes = require('./routes/2fa');
const posTransactionsRoutes = require('./routes/pos-transactions');
const cocinaRoutes = require('./routes/cocina');
const ticketsRoutes = require('./routes/tickets'); // ← NUEVO
const diagnosticoRoutes = require('./routes/diagnostico'); // ← solo lectura, solo supervisor
const ticketsCompartidosRoutes = require('./routes/tickets-compartidos'); // ← tickets visibles en todos los iPads
const deviceRoutes = require('./routes/devices'); // ← push de stock bajo
const historialRoutes = require('./routes/historial'); // ← historial de transacciones
const ajustesRoutes = require('./routes/ajustes'); // ← cancelar orden / cambiar producto
const { puertaGeneral } = require('./middleware/auth');
const actividad = require('./services/actividad'); // ← quién hizo cada orden, cobro y gasto
const actividadRoutes = require('./routes/actividad');
const reconstruirRoutes = require('./routes/reconstruir'); // ← rehacer un día desde recibos
const recetasAlEnviar = require('./services/recetasAlEnviar'); // ← recetas al enviar la orden
const push = require('./services/push');
const smoothie = require('./services/smoothie'); // ← Smoothie en Bebidas


const app = express();
const PORT = process.env.PORT || 5000;

// Railway pone un proxy delante: sin esto todas las visitas parecen venir de la misma IP
// y los límites de intentos (login, 2FA) no distinguen a nadie.
app.set('trust proxy', 1);

// ========================
//    MIDDLEWARES
// ========================
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:4000',
    'http://localhost:5173',
    'https://jardindelosconejos.vercel.app',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ========================
//    RUTAS
// ========================
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: '🍽️ Restaurant POS API is running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api', puertaGeneral);          // ← todo exige sesión (menos login, lista de nombres y registro de avisos)
app.use('/api', actividad.middleware); // ← registra quién hizo cada cosa (sale del token de la sesión)
app.use('/api/auth', authRoutes);
app.use('/api/auth', twoFactorRoutes);
app.use('/api/pos-transactions', posTransactionsRoutes);
app.use('/api/users', userRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/tables', tableRoutes);
app.use('/api/orders', recetasAlEnviar.middleware); // ← descuenta recetas al enviar (app iOS)
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/daily', dailySummaryRoutes);
app.use('/api/cocina', cocinaRoutes);
app.use('/api/tickets', ticketsRoutes); // ← NUEVO
app.use('/api/tickets-compartidos', ticketsCompartidosRoutes);
app.use('/api/devices', deviceRoutes); // ← push de stock bajo
app.use('/api/historial', historialRoutes); // ← historial de transacciones
app.use('/api/ajustes', ajustesRoutes); // ← cancelar orden / cambiar producto
app.use('/api/actividad', actividadRoutes); // ← resumen por usuario
app.use('/api/diagnostico', diagnosticoRoutes);
app.use('/api/reconstruir-dia', reconstruirRoutes); // ← rehacer un día desde recibos

// ========================
//    ERROR HANDLERS
// ========================
app.use(notFound);
app.use(errorHandler);

// ========================
//    INICIAR SERVIDOR
// ========================
const start = async () => {
  await connectDB();

  // Sincronizar tabla daily_summaries
  try {
    const DailySummary = require('./models/DailySummary')(sequelize);
    await DailySummary.sync({ alter: true });
    console.log('✅ Tabla daily_summaries sincronizada');
  } catch (error) {
    console.error('⚠️ Error sincronizando daily_summaries:', error.message);
  }

  // Avisos push de stock bajo: revisa cada 5 minutos
  push.iniciarRevisionPeriodica();

  // Producto Smoothie (con foto) en Bebidas
  await smoothie.asegurarProducto();

  app.listen(PORT, () => {
    console.log(`\n🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🌍 Entorno: ${process.env.NODE_ENV || 'development'}\n`);
  });
};

start();
