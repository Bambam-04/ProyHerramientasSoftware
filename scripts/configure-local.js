const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const file = path.join(root, '.env');
let content = fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8')
  : fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const parsed = require('dotenv').parse(content);
if (!parsed.JWT_SECRET || parsed.JWT_SECRET === 'cambia-este-secreto') {
  content = content.replace(/^JWT_SECRET=.*$/m, '');
  content += `\nJWT_SECRET="${randomBytes(48).toString('hex')}"\n`;
}
function setting(key, value) {
  if (!new RegExp(`^${key}=`, 'm').test(content)) content += `${key}="${value}"\n`;
}
setting('CIMA_TIMEZONE', 'America/Tijuana');
setting('HTTPS_PORT', '3443');
setting('TLS_KEY_FILE', '.local/tls/localhost-key.pem');
setting('TLS_CERT_FILE', '.local/tls/localhost-cert.pem');
fs.writeFileSync(file, content);
const folder = path.join(root, '.local', 'tls');
fs.mkdirSync(folder, { recursive: true });
const opensslConfig = path.join(folder, 'openssl.cnf');
fs.writeFileSync(opensslConfig, '[req]\ndistinguished_name=dn\n[dn]\n');
const key = path.join(folder, 'localhost-key.pem'),
  cert = path.join(folder, 'localhost-cert.pem');
if (!fs.existsSync(key) || !fs.existsSync(cert)) {
  const candidates = [
    process.env.OPENSSL_PATH,
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'openssl',
  ].filter(Boolean);
  let done = false;
  for (const exe of candidates) {
    try {
      execFileSync(
        exe,
        [
          'req',
          '-config',
          opensslConfig,
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '365',
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { windowsHide: true, stdio: 'pipe' },
      );
      done = true;
      break;
    } catch {}
  }
  if (!done)
    throw new Error(
      'Instala OpenSSL o define OPENSSL_PATH para generar el certificado local de desarrollo.',
    );
}
console.log('Secreto de sesión y certificado HTTPS local configurados.');
