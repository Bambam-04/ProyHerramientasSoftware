require('dotenv').config();
const express = require('express');
const path = require('node:path');
const { prisma, asyncHandler } = require('./lib/core');
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (process.env.NODE_ENV === 'production' && !req.secure)
    return res.status(426).json({ error: 'La conexión debe usar HTTPS.' });
  next();
});
app.use(express.json({ limit: '12mb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.get(
  '/api/health',
  asyncHandler(async (req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ estado: 'ok', baseDeDatos: 'conectada' });
  }),
);
app.param('id', (req, res, next, value) => {
  if (!/^[1-9]\d*$/.test(value) || +value > 2147483647)
    return res.status(400).json({ error: 'El identificador debe ser un entero positivo válido.' });
  next();
});
app.use('/api', require('./routes/cuentas'));
app.use('/api', require('./routes/operaciones'));
app.use('/api/admin', require('./routes/administracion'));
app.use('/api', (req, res) => res.status(404).json({ error: 'La función solicitada no existe.' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0 }));
app.use((req, res) => res.status(404).send('La página solicitada no existe.'));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.status && err.status >= 400 && err.status < 500)
    return res.status(err.status).json({
      error:
        err.type === 'entity.parse.failed'
          ? 'El cuerpo de la solicitud debe ser JSON válido.'
          : err.type === 'entity.too.large'
            ? 'El archivo o la solicitud es demasiado grande.'
            : err.message,
    });
  const messages = {
    P2002: [409, 'Ya existe un registro con esos datos únicos.'],
    P2025: [404, 'El registro solicitado no existe.'],
    P2003: [409, 'La operación entra en conflicto con registros relacionados.'],
    P2034: [409, 'Otra operación modificó estos datos. Actualiza la página e inténtalo de nuevo.'],
  };
  if (messages[err.code]) {
    const [status, error] = messages[err.code];
    return res.status(status).json({ error });
  }
  if (err.name === 'PrismaClientValidationError')
    return res.status(400).json({ error: 'Los datos de la solicitud no son válidos.' });
  if (err.name === 'PrismaClientInitializationError' || /^P10\d\d$/.test(err.code || ''))
    return res
      .status(503)
      .json({ error: 'La base de datos no está disponible. Intenta de nuevo más tarde.' });
  console.error('Error CIMA:', err.code || err.name);
  res.status(500).json({ error: 'No se pudo completar la operación.' });
});
module.exports = app;
