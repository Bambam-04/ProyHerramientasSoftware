require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const app = require('./app');
const { prisma } = require('./lib/core');
const { runAutomation } = require('./lib/automation');
const { backup, folder } = require('../scripts/backup');
const { prepare } = require('../scripts/prepare');
const servers = [];
const timers = [];
let closing = false;
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, process.env.HOST || '127.0.0.1', () => {
      servers.push(server);
      resolve();
    });
  });
}
async function dailyBackup() {
  try {
    await backup();
  } catch (error) {
    console.error(error.message);
  }
}
async function start() {
  await prisma.$connect();
  await prepare();
  // Comprueba el respaldo en cada inicio y cada hora; se realiza al menos cada 24h.
  await dailyBackup();
  await runAutomation();
  const key = process.env.TLS_KEY_FILE,
    cert = process.env.TLS_CERT_FILE;
  const port = Number(process.env.PORT || 3000);
  if (key && cert) {
    const securePort = Number(process.env.HTTPS_PORT || 3443);
    const server = https.createServer(
      {
        key: fs.readFileSync(path.resolve(key)),
        cert: fs.readFileSync(path.resolve(cert)),
        minVersion: 'TLSv1.2',
      },
      app,
    );
    await listen(server, securePort);
    const origin = process.env.PUBLIC_ORIGIN || `https://localhost:${securePort}`;
    const redirect = http.createServer((req, res) => {
      const pathname = req.url.startsWith('/') && !req.url.startsWith('//') ? req.url : '/';
      res.writeHead(308, { Location: origin + pathname, 'Cache-Control': 'no-store' });
      res.end();
    });
    await listen(redirect, port);
    console.log(`CIMA en ${origin} (HTTP ${port} redirige a HTTPS)`);
  } else if (process.env.NODE_ENV === 'production' && !process.env.TRUST_PROXY) {
    throw new Error(
      'Producción necesita TLS_KEY_FILE/TLS_CERT_FILE o un proxy HTTPS con TRUST_PROXY.',
    );
  } else {
    await listen(http.createServer(app), port);
    console.log(
      `CIMA en http://localhost:${port}${process.env.NODE_ENV === 'production' ? ' detrás del proxy HTTPS' : ''}`,
    );
  }
  const tick = setInterval(
    () =>
      runAutomation().catch((error) =>
        console.error('No se completó la revisión automática:', error.code || error.name),
      ),
    5000,
  );
  const daily = setInterval(dailyBackup, 3600000);
  timers.push(tick, daily);
  tick.unref();
  daily.unref();
  fs.mkdirSync(path.join(__dirname, '..', '.local'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', '.local', 'server.pid'), String(process.pid));
  console.log(`Respaldos automáticos en ${folder}`);
}
async function close() {
  if (closing) return;
  closing = true;
  timers.forEach(clearInterval);
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
    await prisma.$disconnect();
  } catch (error) {
    console.error('No se pudo cerrar CIMA:', error.code || error.name);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
start().catch(async (error) => {
  console.error('No se pudo iniciar CIMA:', error.message);
  process.exitCode = 1;
  await close();
});
