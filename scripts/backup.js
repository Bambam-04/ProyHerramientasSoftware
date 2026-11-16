require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const folder = path.resolve(
  process.env.BACKUP_DIR || path.join(__dirname, '..', '.local', 'backups'),
);
let running;
function pgDump() {
  if (process.env.PG_DUMP_PATH) return process.env.PG_DUMP_PATH;
  if (process.platform === 'win32') {
    const root = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL');
    if (fs.existsSync(root))
      for (const version of fs
        .readdirSync(root)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        const exe = path.join(root, version, 'bin', 'pg_dump.exe');
        if (fs.existsSync(exe)) return exe;
      }
  }
  return 'pg_dump';
}
async function backup({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    fs.mkdirSync(folder, { recursive: true });
    const files = fs.readdirSync(folder).filter((f) => /^cima-.*\.dump$/.test(f));
    const latest = files
      .map((f) => fs.statSync(path.join(folder, f)).mtimeMs)
      .sort((a, b) => b - a)[0];
    if (!force && latest && Date.now() - latest < 23 * 3600000)
      return { estado: 'vigente', carpeta: folder };
    const url = new URL(process.env.DATABASE_URL);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(folder, `cima-${stamp}.dump`),
      partial = file + '.partial';
    const childEnv = {
      ...process.env,
      PGPASSWORD: decodeURIComponent(url.password),
      PGCONNECT_TIMEOUT: '15',
    };
    if (url.searchParams.has('sslmode')) childEnv.PGSSLMODE = url.searchParams.get('sslmode');
    try {
      await run(
        pgDump(),
        [
          '--host',
          url.hostname,
          '--port',
          url.port || '5432',
          '--username',
          decodeURIComponent(url.username),
          '--dbname',
          decodeURIComponent(url.pathname.slice(1)),
          '--format=custom',
          '--no-owner',
          '--file',
          partial,
        ],
        { env: childEnv, windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 },
      );
      fs.renameSync(partial, file);
      fs.writeFileSync(
        path.join(folder, 'estado.json'),
        JSON.stringify(
          { fecha: new Date().toISOString(), archivo: path.basename(file), estado: 'ok' },
          null,
          2,
        ),
      );
      return { estado: 'ok', archivo: file };
    } catch (error) {
      fs.writeFileSync(
        path.join(folder, 'estado.json'),
        JSON.stringify(
          {
            fecha: new Date().toISOString(),
            estado: 'error',
            mensaje: 'No se pudo ejecutar el respaldo. Comprueba pg_dump y acceso a PostgreSQL.',
          },
          null,
          2,
        ),
      );
      throw new Error(
        'No se pudo ejecutar el respaldo. Comprueba PG_DUMP_PATH, DATABASE_URL y permisos de la carpeta.',
      );
    }
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}
if (require.main === module)
  backup({ force: true })
    .then((r) => console.log(`Respaldo: ${r.archivo}`))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
module.exports = { backup, folder };
