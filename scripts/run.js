const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
let runtime = process.execPath;

// Prisma 5 distribuye el motor de Windows para x64. Un proceso ARM64 no puede cargarlo.
if (process.platform === 'win32' && process.arch === 'arm64') {
  const candidates = [process.env.CIMA_NODE_PATH];
  const fnmRoots = [
    process.env.FNM_DIR,
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'fnm'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'fnm'),
  ].filter(Boolean);

  for (const fnmRoot of fnmRoots) {
    const versions = path.join(fnmRoot, 'node-versions');
    if (!fs.existsSync(versions)) continue;
    const names = fs
      .readdirSync(versions)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const name of names)
      candidates.push(path.join(versions, name, 'installation', 'node.exe'));
  }

  runtime = candidates.find((candidate) => {
    if (!candidate || !fs.existsSync(candidate)) return false;
    try {
      return (
        execFileSync(candidate, ['-p', 'process.arch'], {
          encoding: 'utf8',
          windowsHide: true,
        }).trim() === 'x64'
      );
    } catch {
      return false;
    }
  });

  if (!runtime) {
    console.error(
      'Prisma 5 necesita Node.js x64 en Windows. Instala Node.js x64 con fnm o define CIMA_NODE_PATH con la ruta a su node.exe.',
    );
    process.exit(1);
  }
  console.log(`Usando Node.js x64: ${runtime}`);
}

if (!process.argv[2]) {
  console.error('Uso: node scripts/run.js <archivo.js> [argumentos]');
  process.exit(1);
}

const child = spawn(runtime, [path.resolve(root, process.argv[2]), ...process.argv.slice(3)], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('error', (error) => {
  console.error(`No se pudo iniciar Node.js: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
