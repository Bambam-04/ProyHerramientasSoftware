require('dotenv').config();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const base = new URL(process.env.BASE_URL || `https://localhost:${process.env.HTTPS_PORT || 3443}`);
const certificate = process.env.CIMA_CA_FILE || process.env.TLS_CERT_FILE;
const ca = certificate && fs.existsSync(certificate) ? fs.readFileSync(certificate) : undefined;
const domain = process.env.DOMINIO_INSTITUCIONAL || 'uabc.edu.mx';
let count = 0;
async function request(method, route, { token, body, status = 200 } = {}) {
  const url = new URL(route, base);
  const result = await new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method,
        ...(ca ? { ca } : {}),
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            return reject(new Error(`${route}: la respuesta no es JSON válido.`));
          }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error('Tiempo de espera agotado.')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
  assert.equal(result.status, status, `${route}: HTTP ${result.status}, esperado ${status}`);
  count++;
  return result.data;
}
async function main() {
  const health = await request('GET', '/api/health');
  assert.equal(health.estado, 'ok');
  await request('GET', '/api/materiales', { status: 401 });
  const credentials = [
    ['admin', 'Admin1234', 'ADMIN'],
    ['ventanilla', 'Ventanilla1234', 'ENCARGADO'],
    ['alumno', 'Alumno1234', 'ALUMNO'],
  ];
  for (const [name, password, rol] of credentials) {
    const data = await request('POST', '/api/login', {
      body: { identificador: `${name}@${domain}`, password },
    });
    assert.equal(data.usuario.rol, rol);
    const token = data.token;
    const path =
      rol === 'ADMIN'
        ? '/api/admin/materiales'
        : rol === 'ENCARGADO'
          ? '/api/operacion/prestamos'
          : '/api/materiales';
    assert.ok(Array.isArray(await request('GET', path, { token })));
    if (rol !== 'ADMIN') await request('GET', '/api/admin/actividad', { token, status: 403 });
    if (rol === 'ALUMNO') await request('GET', '/api/operacion/prestamos', { token, status: 403 });
    const rules = await request('GET', '/api/reglas', { token });
    assert.equal(typeof rules.configuracion.toleranciaMinutos, 'number');
  }
  console.log(
    `Instancia ${base.origin}: ${count} comprobaciones correctas, TLS validado y tres roles operativos.`,
  );
}
main().catch((error) => {
  console.error('Comprobación de instancia falló:', error.message);
  process.exitCode = 1;
});
