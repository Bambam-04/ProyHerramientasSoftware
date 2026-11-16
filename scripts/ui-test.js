/* Verificación de interfaz con Edge real. Los datos se aíslan por identificador;
 * las cuentas de demostración y los registros históricos existentes se conservan. */
require('dotenv').config();
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const { chromium, expect: baseExpect } = require('@playwright/test');
const expect = baseExpect.configure({ timeout: 15000 });

const RealDate = Date;
const CLOCK = RealDate.parse('2026-11-16T18:00:00.000Z');
global.Date = class Date extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [CLOCK]));
  }
  static now() {
    return CLOCK;
  }
};
const { prisma, config, localParts, isWeekend } = require('../src/lib/core');
const app = require('../src/app');
const prefix = `ui-${randomUUID().slice(0, 8)}`;
const domain = process.env.DOMINIO_INSTITUCIONAL || 'uabc.edu.mx';
const password = 'PruebaNavegador123';
const outputDir = path.join(__dirname, '..', '.local', 'ui');
const users = {};
const pages = {};
const errors = [];
const networkErrors = [];
let browser, server, base;
let steps = 0;
let cartVisibilityChecked = false;

async function screen(page, name, fullPage = false) {
  await page.screenshot({
    path: path.join(outputDir, `${name}.png`),
    fullPage,
    animations: 'disabled',
  });
}

async function newPage(label, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: 'America/Tijuana',
    locale: 'es-MX',
    acceptDownloads: true,
  });
  await context.addInitScript(
    ({ clock }) => {
      const OriginalDate = Date;
      globalThis.Date = class Date extends OriginalDate {
        constructor(...args) {
          super(...(args.length ? args : [clock]));
        }
        static now() {
          return clock;
        }
      };
    },
    { clock: CLOCK },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('dialog', (dialog) => dialog.accept());
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/favicon\.ico/i.test(message.location().url || ''))
      errors.push(`${label}: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500)
      networkErrors.push(`${label}: ${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    if (!/ERR_ABORTED/.test(request.failure()?.errorText || ''))
      networkErrors.push(`${label}: ${request.failure()?.errorText} ${request.url()}`);
  });
  pages[label] = page;
  return page;
}

async function login(page, user, target) {
  await page.goto(`${base}/index.html`);
  await page.locator('#correo').fill(user.correo);
  await page.locator('#password').fill(password);
  await Promise.all([page.waitForURL(`**/${target}`), page.locator('#entrar').click()]);
  await expect(page.locator('#quien')).toContainText(user.nombre);
  steps++;
}

async function noOverflow(page) {
  const size = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    size.document <= size.width + 1 && size.body <= size.width + 1,
    `La interfaz desborda el ancho móvil: ${JSON.stringify(size)}`,
  );
  steps++;
}

async function fixtures() {
  const hash = await bcrypt.hash(password, 10);
  for (const [label, rol] of [
    ['admin', 'ADMIN'],
    ['encargado', 'ENCARGADO'],
    ['alumno', 'ALUMNO'],
  ]) {
    const matricula = `${prefix}-${label}`;
    const correo = `${matricula}@${domain}`;
    if (rol === 'ALUMNO')
      await prisma.padron.create({
        data: {
          matricula,
          correo,
          nombre: `${prefix} Alumno`,
          rol,
          activo: true,
          carrera: 'Química',
          periodo: '2026-2',
        },
      });
    users[label] = await prisma.usuario.create({
      data: {
        matricula,
        correo,
        nombre: `${prefix} ${label}`,
        rol,
        passwordHash: hash,
        activo: true,
      },
    });
  }
  async function createMaterial(label, cantidadTotal) {
    return prisma.material.create({
      data: {
        nombre: `${prefix} ${label}`,
        categoria: prefix,
        caracteristicas: 'Material de laboratorio para verificación de interfaz',
        maxHoras: 4,
        cantidadTotal,
        piezas: {
          create: Array.from({ length: cantidadTotal }, (_, n) => ({
            codigo: `${prefix}-${label}-${n + 1}`,
          })),
        },
      },
    });
  }
  return {
    cancelable: await createMaterial('Cancelable', 1),
    flow: await createMaterial('Flujo completo', 2),
  };
}

async function collection() {
  const cfg = await config();
  const earliest = CLOCK + Math.max(30, cfg.anticipacionMinMinutos + 1) * 60000;
  const latest = CLOCK + cfg.anticipacionMaxHoras * 3600000;
  for (let time = earliest; time <= latest; time += 60000) {
    const d = new Date(time);
    const p = localParts(d);
    const hour = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    if (!isWeekend(d) && hour >= cfg.horaApertura && hour <= cfg.horaCierre)
      return {
        day: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
        hour,
      };
  }
  throw new Error('No hay horario de recolección habilitado para ejecutar la prueba.');
}

async function requestViaUI(page, material, cantidad = 1) {
  await page.locator('[data-tab="catalogo"]').click();
  await page.locator('#buscar').fill(material.nombre);
  await expect(page.locator('#materiales article.material')).toHaveCount(1);
  await page.locator(`#cantidad-${material.id}`).fill(String(cantidad));
  await page.locator(`[data-agregar="${material.id}"]`).click();
  await expect(page.locator('#cart-count')).toHaveText(String(cantidad));
  await expect(page.locator('#solicitud-form')).toBeVisible();
  if (!cartVisibilityChecked) {
    await page.locator(`[data-quitar="${material.id}"]`).click();
    await expect(page.locator('#cart-count')).toHaveText('0');
    await expect(page.locator('#solicitud-form')).toBeHidden();
    await page.locator(`[data-agregar="${material.id}"]`).click();
    await expect(page.locator('#solicitud-form')).toBeVisible();
    cartVisibilityChecked = true;
    steps++;
  }
  const pickup = await collection();
  await page.locator(`[data-dia="${pickup.day}"]`).click();
  await page.locator('#recogida-hora').fill(pickup.hour);
  await page.locator('#uso-interno').check();
  const weekendChecks = await page
    .locator('#calendario button[data-dia]')
    .evaluateAll((buttons) =>
      buttons
        .filter((b) => [0, 6].includes(new Date(`${b.dataset.dia}T12:00:00Z`).getUTCDay()))
        .every((b) => b.disabled),
    );
  assert.equal(weekendChecks, true, 'El calendario debe deshabilitar sábados y domingos.');
  await noOverflow(page);
  await screen(page, 'alumno-mobile-carrito', true);
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith('/api/prestamos') && r.request().method() === 'POST',
    ),
    page.locator('#enviar').click(),
  ]);
  assert.equal(response.status(), 201, JSON.stringify(await response.json()));
  const result = await response.json();
  await expect(page.locator(`[data-panel="prestamos"]`)).toBeVisible();
  await expect(page.locator(`#mios details[data-detalle="${result.id}"]`)).toBeAttached();
  steps++;
  return result.id;
}

async function studentAndOperation(materials) {
  const alumno = await newPage('alumno', true);
  await alumno.goto(`${base}/index.html`);
  await noOverflow(alumno);
  await screen(alumno, 'login-mobile', true);
  await login(alumno, users.alumno, 'catalogo.html');
  await expect(alumno.locator(`[data-agregar="${materials.cancelable.id}"]`)).toBeVisible();
  await expect(alumno.locator('#solicitud-form')).toBeHidden();
  await noOverflow(alumno);
  await screen(alumno, 'alumno-mobile-catalogo', true);

  const encargado = await newPage('encargado');
  await login(encargado, users.encargado, 'operacion.html');
  await expect(encargado.locator('#pendientes')).toBeVisible();
  await expect(encargado.locator('#nav-admin')).toBeHidden();

  const cancelledId = await requestViaUI(alumno, materials.cancelable);
  await Promise.all([
    alumno.waitForResponse(
      (r) => r.url().endsWith(`/api/prestamos/${cancelledId}/cancelar`) && r.status() === 200,
    ),
    alumno.locator(`[data-cancelar="${cancelledId}"]`).click(),
  ]);
  await expect
    .poll(async () => (await prisma.prestamo.findUnique({ where: { id: cancelledId } })).estado)
    .toBe('CANCELADO');
  steps++;

  const loanId = await requestViaUI(alumno, materials.flow, 2);
  // Se comprueba la actualización periódica del panel sin recargar la página.
  await expect(encargado.locator(`[data-preparar="${loanId}"]`)).toBeVisible();
  await Promise.all([
    encargado.waitForResponse(
      (r) => r.url().endsWith(`/api/operacion/prestamos/${loanId}/preparar`) && r.status() === 200,
    ),
    encargado.locator(`[data-preparar="${loanId}"]`).click(),
  ]);
  const card = alumno.locator(`#mios article.loan-card:has(details[data-detalle="${loanId}"])`);
  await expect(card.locator('.loan-code')).toBeVisible();
  const code = (await card.locator('.loan-code').textContent()).trim();
  assert.match(code, /^CIMA-/);
  await noOverflow(alumno);
  await screen(alumno, 'alumno-mobile-codigo', true);
  await encargado.locator('#codigo-solicitud').fill(code);
  await encargado.locator('#codigo-solicitud').press('Enter');
  await expect(encargado.locator('#dialogo')).toBeVisible();
  await expect(encargado.locator('#entrega-codigo')).toHaveValue(code);
  await expect(encargado.locator('#dialogo')).toContainText(users.alumno.matricula);
  await screen(encargado, 'ventanilla-identidad');
  await encargado.locator('#dialogo [name="identidadVerificada"]').check();
  await encargado.locator('#entrega-fecha').fill('2026-11-16T11:00');
  const current = await prisma.prestamo.findUnique({
    where: { id: loanId },
    include: { piezas: { include: { pieza: true }, orderBy: { id: 'asc' } } },
  });
  // El escaneo no depende del orden: se leen las piezas en orden inverso.
  const invertidos = current.piezas.map((pp) => pp.pieza.codigo).reverse();
  for (let n = 0; n < invertidos.length; n++) {
    await encargado.locator(`#piece-code-${n}`).fill(invertidos[n]);
    await encargado.locator(`#piece-code-${n}`).press('Enter');
    if (n + 1 < invertidos.length)
      await expect(encargado.locator(`#piece-code-${n + 1}`)).toBeFocused();
    await encargado.locator(`#piece-condition-${n}`).selectOption('INTEGRO');
    await encargado.locator(`#piece-notes-${n}`).fill('Salida íntegra verificada con lector.');
  }
  await screen(encargado, 'ventanilla-entrega');
  await Promise.all([
    encargado.waitForResponse(
      (r) => r.url().endsWith(`/api/operacion/prestamos/${loanId}/entregar`) && r.status() === 200,
    ),
    encargado.locator('#modal-submit').click(),
  ]);
  await expect(encargado.locator('#dialogo')).not.toBeVisible();
  await expect
    .poll(async () => (await prisma.prestamo.findUnique({ where: { id: loanId } })).estado)
    .toBe('ENTREGADO');
  await encargado.locator('[data-tab="entregados"]').click();
  await encargado.locator(`[data-devolver="${loanId}"]`).click();
  await expect(encargado.locator('#dialogo')).toBeVisible();
  for (let n = 0; n < invertidos.length; n++) {
    await encargado.locator(`#piece-code-${n}`).fill(invertidos[n]);
    await encargado.locator(`#piece-condition-${n}`).selectOption('INTEGRO');
    await encargado.locator(`#piece-notes-${n}`).fill('Regreso íntegro y completo.');
  }
  await screen(encargado, 'ventanilla-devolucion');
  await Promise.all([
    encargado.waitForResponse(
      (r) => r.url().endsWith(`/api/operacion/prestamos/${loanId}/devolver`) && r.status() === 200,
    ),
    encargado.locator('#modal-submit').click(),
  ]);
  await expect(encargado.locator('#dialogo')).not.toBeVisible();
  await expect
    .poll(async () => (await prisma.prestamo.findUnique({ where: { id: loanId } })).estado)
    .toBe('DEVUELTO');
  await expect(card.locator('.badge')).toHaveText('Devuelto');
  await noOverflow(alumno);
  await screen(alumno, 'alumno-mobile-historial', true);
  steps += 4;
  console.log(
    'Alumno móvil: búsqueda, carrito, cancelación, código y devolución; ventanilla: identidad y escaneo por teclado, correctos.',
  );
}

async function administration() {
  const admin = await newPage('admin');
  await login(admin, users.admin, 'admin.html');
  await expect(admin.locator('#nuevo-material')).toBeVisible();
  await expect(admin.locator('#stat-materiales')).not.toHaveText('0');
  await admin.locator('#nuevo-material').click();
  await admin.locator('#f-nombre').fill(`${prefix} Creado en navegador`);
  await admin.locator('#f-categoria').fill(prefix);
  await admin
    .locator('#f-caracteristicas')
    .fill('Registro individual de inventario desde interfaz de administración.');
  await admin.locator('#f-cantidadTotal').fill('2');
  await admin.locator('#f-maxHoras').fill('4');
  const [created] = await Promise.all([
    admin.waitForResponse(
      (r) => r.url().endsWith('/api/admin/materiales') && r.request().method() === 'POST',
    ),
    admin.locator('#modal-submit').click(),
  ]);
  assert.equal(created.status(), 201, JSON.stringify(await created.json()));
  await expect(admin.locator('#dialogo')).not.toBeVisible();
  await admin.locator('#inventario-buscar').fill(prefix);
  await expect(admin.locator('#inventario')).toContainText('Creado en navegador');
  await screen(admin, 'admin-inventario');
  steps++;

  await admin.locator('[data-tab="usuarios"]').click();
  await expect(admin.locator('[data-panel="usuarios"]')).toBeVisible();
  await admin.locator('#usuarios-buscar').fill(prefix);
  await expect(admin.locator('#usuarios')).toContainText(users.alumno.correo);
  await admin.getByText('Cargar lista oficial de alumnos inscritos', { exact: true }).click();
  const matricula = `${prefix}-preview`;
  const csv = `matricula,nombre,correo,carrera,periodo,estado\n${matricula},Alumno de vista previa,${matricula}@${domain},Química,2026-2,ACTIVO`;
  await admin.locator('#archivo-alumnos').setInputFiles({
    name: `${prefix}-alumnos.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  const [csvResponse] = await Promise.all([
    admin.waitForResponse(
      (r) => r.url().endsWith('/api/admin/importar/alumnos') && r.request().method() === 'POST',
    ),
    admin.locator('#import-alumnos [type="submit"]').click(),
  ]);
  assert.equal((await csvResponse.json()).valido, true);
  await expect(admin.locator('#preview-alumnos')).toContainText('Validación correcta');
  await expect(admin.locator('#confirmar-alumnos')).toBeVisible();
  assert.equal(
    await prisma.usuario.findUnique({ where: { matricula } }),
    null,
    'La vista previa no debe crear usuarios.',
  );
  await screen(admin, 'admin-import-csv', true);
  steps++;

  await admin.locator('[data-tab="inventario"]').click();
  await admin.getByText('Importar inventario desde CSV o Excel', { exact: true }).click();
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Inventario');
  sheet.addRow(['nombre', 'categoria', 'caracteristicas', 'cantidad', 'maxHoras']);
  const importedName = `${prefix} Sólo vista previa Excel`;
  sheet.addRow([importedName, prefix, 'Carga Excel verificada desde el navegador', 2, 4]);
  await admin.locator('#archivo-materiales').setInputFiles({
    name: `${prefix}-materiales.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(await book.xlsx.writeBuffer()),
  });
  const [xlsxResponse] = await Promise.all([
    admin.waitForResponse(
      (r) => r.url().endsWith('/api/admin/importar/materiales') && r.request().method() === 'POST',
    ),
    admin.locator('#import-materiales [type="submit"]').click(),
  ]);
  assert.equal((await xlsxResponse.json()).valido, true);
  await expect(admin.locator('#preview-materiales')).toContainText('Validación correcta');
  await expect(admin.locator('#confirmar-materiales')).toBeVisible();
  assert.equal(
    await prisma.material.count({ where: { nombre: importedName } }),
    0,
    'La vista previa no debe agregar inventario.',
  );
  await screen(admin, 'admin-import-xlsx', true);
  steps++;

  for (const tab of ['configuracion', 'avisos', 'actividad', 'incidencias']) {
    await admin.locator(`[data-tab="${tab}"]`).click();
    await expect(admin.locator(`[data-panel="${tab}"]`)).toBeVisible();
    if (tab === 'configuracion') await expect(admin.locator('#tolerancia')).not.toHaveValue('');
    if (tab === 'avisos') await expect(admin.locator('#nuevo-aviso')).toBeVisible();
    if (tab === 'actividad') {
      await expect(admin.locator('#actividad')).toContainText(users.admin.nombre);
      await screen(admin, 'admin-bitacora');
    }
    steps++;
  }
  await admin.locator('[data-tab="reportes"]').click();
  await admin.locator('#reporte-usuario').selectOption(String(users.alumno.id));
  const [report] = await Promise.all([
    admin.waitForResponse(
      (r) => r.url().includes('/api/admin/reportes?') && r.url().includes('formato=json'),
    ),
    admin.locator('#reporte-form [type="submit"]').click(),
  ]);
  assert.equal(report.status(), 200);
  await expect(admin.locator('#reporte-resumen')).toContainText('2 registro(s)');
  await screen(admin, 'admin-reportes');
  const [download] = await Promise.all([
    admin.waitForEvent('download'),
    admin.locator('[data-exportar="pdf"]').click(),
  ]);
  assert.match(download.suggestedFilename(), /\.pdf$/i);
  const pdfPath = path.join(outputDir, 'reporte-browser.pdf');
  await download.saveAs(pdfPath);
  assert.equal((await fs.readFile(pdfPath)).subarray(0, 4).toString(), '%PDF');
  steps += 2;
  console.log(
    'Administrador: alta de material, módulos, vistas previas CSV/Excel y descarga PDF, correctos.',
  );
}

async function cleanup() {
  const accounts = await prisma.usuario.findMany({
    where: { matricula: { startsWith: prefix } },
    select: { id: true },
  });
  const materials = await prisma.material.findMany({
    where: { nombre: { startsWith: prefix } },
    select: { id: true },
  });
  const userIds = accounts.map((u) => u.id);
  const materialIds = materials.map((m) => m.id);
  const loans = await prisma.prestamo.findMany({
    where: { usuarioId: { in: userIds } },
    select: { id: true },
  });
  const loanIds = loans.map((p) => p.id);
  await prisma.$transaction([
    prisma.convenio.deleteMany({ where: { usuarioId: { in: userIds } } }),
    prisma.adeudo.deleteMany({ where: { usuarioId: { in: userIds } } }),
    prisma.incidencia.deleteMany({ where: { usuarioId: { in: userIds } } }),
    prisma.defectoPrevio.deleteMany({ where: { prestamoId: { in: loanIds } } }),
    prisma.prestamoPieza.deleteMany({ where: { prestamoId: { in: loanIds } } }),
    prisma.prestamo.deleteMany({ where: { id: { in: loanIds } } }),
    prisma.notificacion.deleteMany({ where: { usuarioId: { in: userIds } } }),
    prisma.interes.deleteMany({
      where: { OR: [{ usuarioId: { in: userIds } }, { materialId: { in: materialIds } }] },
    }),
    prisma.pieza.deleteMany({ where: { materialId: { in: materialIds } } }),
    prisma.material.deleteMany({ where: { id: { in: materialIds } } }),
    prisma.usuario.deleteMany({ where: { id: { in: userIds } } }),
    prisma.padron.deleteMany({ where: { matricula: { startsWith: prefix } } }),
  ]);
}

(async () => {
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await prisma.$connect();
    const materials = await fixtures();
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      executablePath:
        process.env.CIMA_BROWSER_PATH ||
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true,
    });
    await studentAndOperation(materials);
    await administration();
    assert.deepEqual(errors, [], 'No deben existir errores JavaScript ni bloqueos CSP.');
    assert.deepEqual(networkErrors, [], 'No deben existir fallos de servidor o de red.');
    console.log(
      `Prueba de navegador completada: ${steps} comprobaciones, tres roles y alumno móvil a 390 px. Capturas: .local/ui/.`,
    );
  } catch (error) {
    console.error('Falló la prueba de navegador:', error.stack || error.message);
    for (const [label, page] of Object.entries(pages)) {
      try {
        await screen(page, `fallo-${label}`);
        console.error(
          `${label}: ${await page
            .locator('#msg')
            .textContent()
            .catch(() => '')}`,
        );
      } catch {}
    }
    if (errors.length) console.error('Errores JavaScript/CSP:', errors);
    if (networkErrors.length) console.error('Errores de red:', networkErrors);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    try {
      await cleanup();
      console.log('Fixtures de navegador eliminadas; auditoría conservada.');
    } catch (error) {
      console.error('No se pudieron limpiar fixtures del navegador:', error.message);
      process.exitCode = 1;
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await prisma.$disconnect();
    global.Date = RealDate;
  }
})();
