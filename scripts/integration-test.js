/* Prueba HTTP y PostgreSQL con fixtures aisladas. Conserva deliberadamente la bitácora
 * inmutable; elimina únicamente cuentas, materiales y operaciones creadas por esta ejecución. */
require('dotenv').config();
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const jwt = require('jsonwebtoken');

const RealDate = Date;
const CLOCK = RealDate.parse('2026-11-16T18:00:00.000Z'); // Lunes, 10:00 en Tijuana.
global.Date = class Date extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [CLOCK]));
  }
  static now() {
    return CLOCK;
  }
};
const { prisma, config, localParts, isWeekend, maxReturn } = require('../src/lib/core');
const exported = require('../src/app');
const app = exported.app || exported;
const { runAutomation } = require('../src/lib/automation');

const prefix = `itest-${randomUUID().slice(0, 8)}`;
const domain = process.env.DOMINIO_INSTITUCIONAL || 'uabc.edu.mx';
const password = 'PruebaSegura123';
const extraUserIds = new Set();
const users = {};
let server;
let base;
let checks = 0;

async function request(
  method,
  route,
  { token, body, status = 200, binary = false, html = false, raw } = {},
) {
  const response = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const result = binary
    ? Buffer.from(await response.arrayBuffer())
    : html
      ? await response.text()
      : await response.json();
  const permitted = Array.isArray(status) ? status : [status];
  assert.ok(
    permitted.includes(response.status),
    `${method} ${route}: esperaba ${permitted.join('/')}, recibió ${response.status}: ${binary ? 'archivo' : JSON.stringify(result).slice(0, 600)}`,
  );
  if (response.status >= 400 && !html && !binary)
    assert.equal(
      typeof result.error,
      'string',
      'Los errores deben devolver un mensaje comprensible.',
    );
  checks++;
  return result;
}

async function login(user, pass = password) {
  const data = await request('POST', '/login', {
    body: { identificador: user.correo, correo: user.correo, password: pass },
  });
  assert.equal(typeof data.token, 'string');
  assert.equal(data.usuario.rol, user.rol);
  return data.token;
}

async function fixtureUsers() {
  const hash = await bcrypt.hash(password, 10);
  for (const [name, rol] of [
    ['admin', 'ADMIN'],
    ['encargado', 'ENCARGADO'],
    ['uno', 'ALUMNO'],
    ['dos', 'ALUMNO'],
  ]) {
    const matricula = `${prefix}-${name}`;
    const correo = `${matricula}@${domain}`;
    if (rol === 'ALUMNO')
      await prisma.padron.create({
        data: {
          matricula,
          nombre: `${prefix} ${name}`,
          correo,
          rol,
          activo: true,
          carrera: 'Química',
          periodo: '2026-2',
        },
      });
    users[name] = await prisma.usuario.create({
      data: {
        matricula,
        correo,
        nombre: `${prefix} ${name}`,
        rol,
        passwordHash: hash,
        debeCambiarPassword: false,
      },
    });
  }
  for (const u of Object.values(users)) u.token = await login(u);
}

async function material(label, cantidadTotal = 1, maxHoras = 4) {
  return request('POST', '/admin/materiales', {
    token: users.admin.token,
    status: 201,
    body: {
      nombre: `${prefix} ${label}`,
      categoria: prefix,
      caracteristicas: 'Material temporal para prueba integral',
      cantidadTotal,
      maxHoras,
    },
  });
}

async function pickupTime() {
  const cfg = await config();
  const earliest = CLOCK + Math.max(30, cfg.anticipacionMinMinutos + 1) * 60000;
  const latest = CLOCK + cfg.anticipacionMaxHoras * 3600000;
  for (let value = earliest; value <= latest; value += 60000) {
    const date = new Date(value);
    const p = localParts(date);
    const hhmm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
    if (!isWeekend(date) && hhmm >= cfg.horaApertura && hhmm <= cfg.horaCierre)
      return date.toISOString();
  }
  throw new Error(
    'La configuración actual no ofrece horario de recolección dentro de la anticipación permitida.',
  );
}

async function reservar(user, materiales, options = {}) {
  return request('POST', '/prestamos', {
    token: user.token,
    status: options.status || 201,
    body: {
      items: materiales.map((m) => ({ materialId: m.id, cantidad: 1 })),
      fechaRecoleccion: await pickupTime(),
      aceptaUsoInterno: true,
      ...options.body,
    },
  });
}

async function loan(id) {
  return prisma.prestamo.findUnique({
    where: { id },
    include: {
      piezas: { include: { pieza: { include: { material: true } } } },
      defectos: true,
      incidencias: { include: { adeudo: true } },
    },
  });
}

function lecturas(p, condicion = 'INTEGRO') {
  return p.piezas.map((pp) => ({
    codigo: pp.pieza.codigo,
    condicion,
    notas: 'Revisión física de prueba integral',
  }));
}

async function preparar(id) {
  return request('POST', `/operacion/prestamos/${id}/preparar`, { token: users.encargado.token });
}

async function entregar(id, changes = {}, status = 200) {
  const p = await loan(id);
  return request('POST', `/operacion/prestamos/${id}/entregar`, {
    token: users.encargado.token,
    status,
    body: {
      codigo: p.codigo,
      identidadVerificada: true,
      fechaDevolucion: new Date(CLOCK + 30 * 60000).toISOString(),
      piezas: lecturas(p),
      ...changes,
    },
  });
}

async function devolver(id, changes = {}, status = 200) {
  return request('POST', `/operacion/prestamos/${id}/devolver`, {
    token: users.encargado.token,
    status,
    body: { piezas: lecturas(await loan(id)), ...changes },
  });
}

async function authChecks() {
  const alternateCase = await request('POST', '/login', {
    body: { identificador: users.uno.matricula.toUpperCase(), password },
  });
  assert.equal(
    alternateCase.usuario.id,
    users.uno.id,
    'La matrícula debe aceptarse sin distinguir mayúsculas.',
  );
  await request('GET', '/materiales', { status: 401 });
  await request('GET', '/admin/usuarios', { token: users.uno.token, status: 403 });
  await request('GET', '/admin/usuarios', { token: users.encargado.token, status: 403 });
  await request('GET', '/operacion/prestamos', { token: users.uno.token, status: 403 });
  await request('GET', '/operacion/prestamos', { token: users.encargado.token });
  await request('POST', '/prestamos', { token: users.encargado.token, body: {}, status: 403 });
  await request('POST', '/registro', { raw: '{"correo":', status: 400 });
  await request('POST', '/login', {
    body: { correo: users.uno.correo, password: 'Incorrecta1' },
    status: 401,
  });
  await login(users.uno);
  const matricula = `${prefix}-registro`;
  const correo = `${matricula}@${domain}`;
  await prisma.padron.create({
    data: { matricula, correo, nombre: `${prefix} Registro`, rol: 'ALUMNO' },
  });
  await request('POST', '/registro', {
    body: { matricula, correo: `${prefix}@externo.example`, password },
    status: [400, 403],
  });
  await request('POST', '/registro', { body: { matricula, correo, password }, status: 201 });
  await request('POST', '/registro', { body: { matricula, correo, password }, status: 409 });
  const registrado = await prisma.usuario.findUnique({ where: { matricula } });
  assert.notEqual(registrado.passwordHash, password, 'La contraseña debe almacenarse como hash.');
  assert.equal(await bcrypt.compare(password, registrado.passwordHash), true);
  await login(registrado);
  const inactiva = `${prefix}-inactiva`;
  await prisma.padron.create({
    data: {
      matricula: inactiva,
      correo: `${inactiva}@${domain}`,
      nombre: 'Inscripción inactiva',
      rol: 'ALUMNO',
      activo: false,
    },
  });
  await request('POST', '/registro', {
    body: { matricula: inactiva, correo: `${inactiva}@${domain}`, password },
    status: 403,
  });
  // Bloqueo temporal luego de cinco intentos fallidos, sin afectar cuentas de demostración.
  for (let i = 0; i < 5; i++)
    await request('POST', '/login', {
      body: { correo: registrado.correo, password: 'Incorrecta123' },
      status: [401, 423],
    });
  await request('POST', '/login', { body: { correo: registrado.correo, password }, status: 423 });
  await prisma.usuario.update({
    where: { id: registrado.id },
    data: { bloqueadoHasta: new Date(CLOCK - 1), intentos: 0 },
  });
  await login(registrado);
  console.log('Autenticación, padrón, bloqueo y permisos por rol: correcto.');
}

async function stockAndFifo() {
  const unitario = await material('última unidad');
  const results = await Promise.allSettled([
    reservar(users.uno, [unitario]),
    reservar(users.dos, [unitario]),
  ]);
  // El helper de cada solicitud exige 201; la segunda debe fallar por HTTP 409.
  assert.equal(
    results.filter((r) => r.status === 'fulfilled').length,
    1,
    'Sólo un alumno puede reservar la última pieza.',
  );
  const rejected = results.find((r) => r.status === 'rejected');
  assert.match(
    rejected.reason.message,
    /recibió 409/,
    'La solicitud concurrente debe informar falta de stock.',
  );
  const winnerIndex = results.findIndex((r) => r.status === 'fulfilled');
  const winner = [users.uno, users.dos][winnerIndex];
  const other = [users.uno, users.dos][1 - winnerIndex];
  const first = results[winnerIndex].value;
  assert.equal(
    await prisma.pieza.count({ where: { materialId: unitario.id, estado: 'RESERVADA' } }),
    1,
  );
  assert.equal(
    await prisma.prestamo.count({ where: { materialId: unitario.id, estado: 'PENDIENTE' } }),
    1,
  );
  await request('POST', `/materiales/${unitario.id}/interes`, {
    token: users.dos.token,
    status: 201,
  });
  await request('POST', `/prestamos/${first.id}/cancelar`, { token: other.token, status: 404 });
  await request('POST', `/admin/materiales/${unitario.id}/baja`, {
    token: users.admin.token,
    status: 409,
  });
  await request('POST', `/prestamos/${first.id}/cancelar`, { token: winner.token });
  assert.equal(
    await prisma.pieza.count({ where: { materialId: unitario.id, estado: 'DISPONIBLE' } }),
    1,
  );
  assert.ok(
    await prisma.notificacion.count({ where: { usuarioId: users.dos.id, tipo: 'DISPONIBILIDAD' } }),
  );
  const notificaciones = await request('GET', '/notificaciones', { token: users.dos.token });
  assert.ok(
    notificaciones.some((n) => n.tipo === 'DISPONIBILIDAD' && n.mensaje.includes(unitario.nombre)),
  );
  await request('POST', `/prestamos/${first.id}/cancelar`, { token: winner.token, status: 409 });

  const limitado = await material('límite dos horas', 2, 2);
  const largo = await material('límite cuatro horas', 2, 4);
  await reservar(users.uno, [limitado], { status: 400, body: { aceptaUsoInterno: false } });
  await reservar(users.uno, [limitado], {
    status: 400,
    body: { fechaRecoleccion: '2026-11-21T18:00:00.000Z' },
  });
  const p1 = await reservar(users.uno, [limitado, largo]);
  const p2 = await reservar(users.dos, [limitado]);
  await request('POST', `/operacion/prestamos/${p2.id}/preparar`, {
    token: users.encargado.token,
    status: 409,
  });
  const preparada = await preparar(p1.id);
  assert.match(preparada.codigo, /^CIMA-/);
  await request('POST', `/prestamos/${p1.id}/cancelar`, { token: users.uno.token, status: 409 });
  await request('POST', `/prestamos/${p2.id}/cancelar`, { token: users.dos.token });
  const detalle = await request('GET', `/operacion/prestamos/codigo/${preparada.codigo}`, {
    token: users.encargado.token,
  });
  assert.equal(detalle.usuario.matricula, users.uno.matricula);
  assert.equal(detalle.piezas.length, 2);
  assert.equal(Object.hasOwn(detalle.usuario, 'passwordHash'), false);
  await entregar(p1.id, { identidadVerificada: false }, 400);
  await entregar(p1.id, { codigo: 'CODIGO-AJENO' }, 409);
  await entregar(p1.id, { piezas: lecturas(await loan(p1.id), 'DANADO') }, 409);
  await entregar(p1.id, { piezas: [{ codigo: 'PIEZA-AJENA', condicion: 'INTEGRO' }] }, 409);
  await entregar(p1.id, { piezas: lecturas(await loan(p1.id)).slice(0, 1) }, 400);
  await entregar(p1.id, { fechaDevolucion: new Date(CLOCK + 3 * 3600000).toISOString() }, 400);
  await entregar(p1.id, { fechaDevolucion: '2026-11-21T18:00:00.000Z' }, 400);
  await entregar(p1.id);
  await request('POST', `/operacion/prestamos/${p1.id}/rechazar`, {
    token: users.encargado.token,
    status: 409,
  });
  await devolver(p1.id);
  await devolver(p1.id, {}, 409);
  const p = await loan(p1.id);
  assert.equal(p.estado, 'DEVUELTO');
  assert.equal(p.incidencias.length, 0);
  assert.ok(p.piezas.every((pp) => pp.pieza.estado === 'DISPONIBLE' && pp.devuelta));
  const friday = new Date('2026-11-20T18:00:00.000Z');
  const adjusted = maxReturn(friday, 48, '20:00');
  assert.equal(
    isWeekend(adjusted),
    false,
    'El máximo que cae en fin de semana debe ajustarse al viernes anterior.',
  );
  assert.equal(localParts(adjusted).weekday, 5);
  assert.equal(localParts(adjusted).hour, 20);
  assert.ok(adjusted <= new Date(friday.getTime() + 48 * 3600000));
  console.log('Concurrencia, FIFO, cancelaciones, códigos y límites de entrega: correcto.');
}

// Entrega por material (sin orden ni pieza fija), reactivación de material y vencimiento
// automático de solicitudes pendientes que no se prepararon a tiempo.
async function substitutionMaintenanceAndExpiry() {
  const vasos = await material('vasos sustituibles', 3);
  const ajeno = await material('material ajeno', 1);
  const p = await reservar(users.uno, [vasos]);
  await preparar(p.id);
  const antes = await loan(p.id);
  const reservada = antes.piezas[0].pieza;
  const libre = await prisma.pieza.findFirst({
    where: { materialId: vasos.id, estado: 'DISPONIBLE' },
  });
  const otra = await prisma.pieza.findFirst({ where: { materialId: ajeno.id } });
  await entregar(p.id, { piezas: [{ codigo: otra.codigo, condicion: 'INTEGRO' }] }, 409);
  const consulta = await request('GET', `/operacion/piezas/codigo/${libre.codigo}`, {
    token: users.encargado.token,
  });
  assert.equal(consulta.materialId, vasos.id);
  await request('GET', '/operacion/piezas/codigo/NO-EXISTE', {
    token: users.encargado.token,
    status: 404,
  });
  await request('GET', `/operacion/piezas/codigo/${libre.codigo}`, {
    token: users.uno.token,
    status: 403,
  });
  await entregar(p.id, { piezas: [{ codigo: libre.codigo, condicion: 'INTEGRO' }] });
  const despues = await loan(p.id);
  assert.equal(despues.estado, 'ENTREGADO');
  assert.equal(despues.piezas.length, 1);
  assert.equal(despues.piezas[0].piezaId, libre.id, 'La reserva se reasigna a la pieza entregada.');
  assert.equal(despues.piezas[0].pieza.estado, 'PRESTADA');
  assert.equal(
    (await prisma.pieza.findUnique({ where: { id: reservada.id } })).estado,
    'DISPONIBLE',
    'La pieza reservada originalmente vuelve al inventario.',
  );
  await devolver(p.id);

  const piezas = await prisma.pieza.findMany({
    where: { materialId: vasos.id },
    orderBy: { id: 'asc' },
  });
  await request('PATCH', `/admin/piezas/${piezas[0].id}`, {
    token: users.admin.token,
    body: { estado: 'MANTENIMIENTO', condicion: 'DANADO' },
  });
  await request('PATCH', `/admin/materiales/${vasos.id}`, {
    token: users.admin.token,
    body: { estado: 'MANTENIMIENTO' },
  });
  assert.equal(
    await prisma.pieza.count({ where: { materialId: vasos.id, estado: 'MANTENIMIENTO' } }),
    3,
  );
  const reactivado = await request('PATCH', `/admin/materiales/${vasos.id}`, {
    token: users.admin.token,
    body: { estado: 'ACTIVO' },
  });
  assert.deepEqual(reactivado.reactivacion, { liberadas: 2, enRevision: 1 });
  assert.equal(
    (await prisma.pieza.findUnique({ where: { id: piezas[0].id } })).estado,
    'MANTENIMIENTO',
    'La pieza dañada sigue en revisión tras reactivar el material.',
  );
  const catalogo = await request('GET', `/materiales?q=${encodeURIComponent(vasos.nombre)}`, {
    token: users.uno.token,
  });
  assert.equal(catalogo[0].estado, 'Disponible');
  assert.equal(catalogo[0].disponibles, 2);

  const vencida = await reservar(users.uno, [vasos]);
  const siguiente = await reservar(users.dos, [vasos]);
  const cfg = await config();
  await prisma.prestamo.update({
    where: { id: vencida.id },
    data: { fechaRecoleccion: new Date(CLOCK - (cfg.toleranciaMinutos + 1) * 60000) },
  });
  await request('POST', `/operacion/prestamos/${vencida.id}/preparar`, {
    token: users.encargado.token,
    status: 409,
  });
  await preparar(siguiente.id);
  await runAutomation({ usuarioIds: [users.uno.id, users.dos.id] });
  const cancelada = await loan(vencida.id);
  assert.equal(cancelada.estado, 'CANCELADO');
  assert.ok(cancelada.piezas.every((pp) => pp.pieza.estado === 'DISPONIBLE'));
  assert.ok(
    await prisma.notificacion.count({
      where: { usuarioId: users.uno.id, tipo: 'SOLICITUD_VENCIDA' },
    }),
  );
  await request('POST', `/operacion/prestamos/${siguiente.id}/rechazar`, {
    token: users.encargado.token,
  });
  console.log(
    'Entrega por material con reasignación, reactivación de inventario y vencimiento de pendientes: correcto.',
  );
}

async function additionalGuards() {
  const expiredToken = jwt.sign(
    { id: users.uno.id, version: users.uno.sessionVersion },
    process.env.JWT_SECRET,
    { expiresIn: -1, algorithm: 'HS256', issuer: 'cima', audience: 'cima-web' },
  );
  await request('GET', '/materiales', { token: expiredToken, status: 401 });
  const searchable = await material('búsqueda exacta');
  const found = await request(
    'GET',
    `/materiales?q=${encodeURIComponent(`${prefix} búsqueda`)}&categoria=${prefix}`,
    { token: users.uno.token },
  );
  assert.deepEqual(
    found.map((m) => m.id),
    [searchable.id],
  );
  const empty = await request('GET', `/materiales?q=${prefix}-sin-coincidencias`, {
    token: users.uno.token,
  });
  assert.deepEqual(empty, []);
  const aviso = await request('POST', '/admin/avisos', {
    token: users.admin.token,
    status: 201,
    body: {
      titulo: `${prefix} Aviso visible`,
      contenido: 'El horario de atención de prueba se encuentra activo.',
    },
  });
  assert.ok(
    (await request('GET', '/avisos', { token: users.uno.token })).some((a) => a.id === aviso.id),
  );
  await request('PATCH', `/admin/avisos/${aviso.id}`, {
    token: users.admin.token,
    body: { activo: false },
  });
  assert.equal(
    (await request('GET', '/avisos', { token: users.uno.token })).some((a) => a.id === aviso.id),
    false,
  );

  // Dos transiciones distintas sobre la misma solicitud no pueden completarse a la vez.
  const raced = await reservar(users.uno, [searchable]);
  await preparar(raced.id);
  const prepared = await loan(raced.id);
  const deliveryBody = {
    codigo: prepared.codigo,
    identidadVerificada: true,
    fechaDevolucion: new Date(CLOCK + 30 * 60000).toISOString(),
    piezas: lecturas(prepared),
  };
  const transitions = await Promise.allSettled([
    request('POST', `/operacion/prestamos/${raced.id}/entregar`, {
      token: users.encargado.token,
      body: deliveryBody,
    }),
    request('POST', `/operacion/prestamos/${raced.id}/rechazar`, {
      token: users.encargado.token,
      body: { motivo: 'Prueba de transición concurrente.' },
    }),
  ]);
  assert.equal(
    transitions.filter((r) => r.status === 'fulfilled').length,
    1,
    'Entrega y rechazo deben ser mutuamente excluyentes.',
  );
  assert.match(transitions.find((r) => r.status === 'rejected').reason.message, /recibió 409/);
  const transitioned = await loan(raced.id);
  assert.ok(['ENTREGADO', 'RECHAZADO'].includes(transitioned.estado));
  if (transitioned.estado === 'ENTREGADO') await devolver(raced.id);
  assert.equal(
    await prisma.pieza.count({ where: { materialId: searchable.id, estado: 'DISPONIBLE' } }),
    1,
  );

  const returning = await reservar(users.uno, [searchable]);
  await preparar(returning.id);
  await entregar(returning.id);
  const returns = await Promise.allSettled([devolver(returning.id), devolver(returning.id)]);
  assert.equal(
    returns.filter((r) => r.status === 'fulfilled').length,
    1,
    'La devolución concurrente debe registrarse una sola vez.',
  );
  assert.match(returns.find((r) => r.status === 'rejected').reason.message, /recibió 409/);
  assert.equal((await loan(returning.id)).estado, 'DEVUELTO');
  assert.equal(
    await prisma.pieza.count({ where: { materialId: searchable.id, estado: 'DISPONIBLE' } }),
    1,
  );
  assert.equal(
    await prisma.actividad.count({
      where: { accion: 'DEVOLVER', detalle: { path: ['prestamoId'], equals: returning.id } },
    }),
    1,
  );
  console.log(
    'JWT expirado, búsqueda, avisos y exclusión de entregas/devoluciones concurrentes: correcto.',
  );
}

async function previousDefect() {
  const mat = await material('defecto previo');
  const p = await reservar(users.uno, [mat]);
  await preparar(p.id);
  await entregar(p.id);
  const actual = await loan(p.id);
  const pp = actual.piezas[0];
  const report = await request('POST', `/prestamos/${p.id}/defectos`, {
    token: users.uno.token,
    status: 201,
    body: {
      prestamoPiezaId: pp.id,
      descripcion: 'Rayadura encontrada al recibir el material',
      condicion: 'RAYADO',
    },
  });
  await devolver(p.id, { piezas: lecturas(actual, 'RAYADO') }, 409);
  await request('POST', `/operacion/defectos/${report.defecto.id}/resolver`, {
    token: users.encargado.token,
    body: { aceptado: true, respuesta: 'Se verificó el defecto preexistente.' },
  });
  const returned = await devolver(p.id, { piezas: lecturas(actual, 'RAYADO') });
  assert.equal(returned.estado, 'DEVUELTO');
  assert.equal(
    returned.incidencias.length,
    0,
    'Un defecto previo aceptado no debe responsabilizar al alumno.',
  );
  assert.equal((await loan(p.id)).piezas[0].pieza.estado, 'MANTENIMIENTO');
  await request('PATCH', `/admin/piezas/${pp.piezaId}`, {
    token: users.admin.token,
    body: { estado: 'DISPONIBLE', condicion: 'INTEGRO' },
  });
  console.log('Defecto previo validado, historial y mantenimiento por pieza: correcto.');
}

async function incidentAndAgreement() {
  const danado = await material('daño');
  const perdido = await material('pérdida');
  const p = await reservar(users.uno, [danado, perdido]);
  await preparar(p.id);
  await entregar(p.id);
  const current = await loan(p.id);
  const piezas = current.piezas.map((pp) => ({
    codigo: pp.pieza.codigo,
    condicion: pp.pieza.materialId === perdido.id ? 'PERDIDO' : 'DANADO',
    notas: '<script>alert("prueba")</script> Daño comprobado en revisión.',
  }));
  await devolver(p.id, { piezas }, 400);
  const result = await devolver(p.id, { piezas, confirmarIncidencias: true });
  assert.equal(result.estado, 'INCIDENCIA');
  assert.equal(result.incidencias.length, 2);
  const debts = await prisma.adeudo.findMany({
    where: { usuarioId: users.uno.id, incidencia: { prestamoId: p.id } },
  });
  assert.equal(debts.length, 2);
  assert.equal(
    (await prisma.pieza.findFirst({ where: { materialId: perdido.id } })).estado,
    'PERDIDA',
  );
  assert.equal((await prisma.material.findUnique({ where: { id: perdido.id } })).cantidadTotal, 0);
  await reservar(users.uno, [danado], { status: 403 });
  const receipt = await request('GET', `/incidencias/${result.incidencias[0].id}/comprobante`, {
    token: users.uno.token,
    html: true,
  });
  assert.ok(receipt.includes('&lt;script&gt;'));
  assert.equal(
    receipt.includes('<script>alert'),
    false,
    'El comprobante debe escapar las observaciones.',
  );
  await request('GET', `/incidencias/${result.incidencias[0].id}/comprobante`, {
    token: users.dos.token,
    status: 404,
  });
  const agreements = [];
  for (const debt of debts) {
    const agreement = await request('POST', '/admin/convenios', {
      token: users.admin.token,
      status: 201,
      body: {
        adeudoId: debt.id,
        descripcion: 'Reposición formal de material de prueba',
        fechaLimite: '2026-11-17T20:00:00.000Z',
      },
    });
    agreements.push(agreement.convenio || agreement);
  }
  const sano = await material('durante convenio');
  const allowed = await reservar(users.uno, [sano]);
  await request('POST', `/prestamos/${allowed.id}/cancelar`, { token: users.uno.token });
  await prisma.convenio.update({
    where: { id: agreements[0].id },
    data: { fechaLimite: new Date(CLOCK - 60000) },
  });
  await runAutomation({ usuarioIds: [users.uno.id, users.dos.id] });
  assert.equal(
    (await prisma.convenio.findUnique({ where: { id: agreements[0].id } })).estado,
    'VENCIDO',
  );
  await reservar(users.uno, [sano], { status: 403 });
  for (const agreement of agreements)
    await request('POST', `/admin/convenios/${agreement.id}/liquidar`, {
      token: users.admin.token,
      body: {
        comprobante: 'Reposición física verificada en almacén',
        notas: 'Liquidación administrativa de prueba; sin pago electrónico.',
      },
    });
  assert.equal(
    await prisma.adeudo.count({
      where: { id: { in: debts.map((d) => d.id) }, estado: 'LIQUIDADO' },
    }),
    2,
  );
  assert.equal(
    (await loan(p.id)).estado,
    'DEVUELTO',
    'La liquidación de todas las incidencias permite cerrar el historial del préstamo.',
  );
  const regularized = await reservar(users.uno, [sano]);
  await request('POST', `/prestamos/${regularized.id}/cancelar`, { token: users.uno.token });
  console.log(
    'Daño/pérdida, comprobante, adeudos, convenios, vencimiento y liquidación: correcto.',
  );
}

async function automationChecks() {
  const mat = await material('automatización');
  const p = await reservar(users.uno, [mat]);
  await preparar(p.id);
  await prisma.prestamo.update({
    where: { id: p.id },
    data: { limiteRecogida: new Date(CLOCK - 1) },
  });
  await runAutomation({ usuarioIds: [users.uno.id, users.dos.id] });
  assert.equal((await loan(p.id)).estado, 'NO_RECOGIDO');
  assert.equal(
    await prisma.pieza.count({ where: { materialId: mat.id, estado: 'DISPONIBLE' } }),
    1,
  );
  assert.ok(
    await prisma.notificacion.count({ where: { usuarioId: users.uno.id, tipo: 'NO_RECOGIDO' } }),
  );
  const active = await reservar(users.uno, [mat]);
  await preparar(active.id);
  await entregar(active.id);
  await prisma.prestamo.update({
    where: { id: active.id },
    data: { fechaDevolucion: new Date(CLOCK + 5 * 60000) },
  });
  const before = await prisma.notificacion.count({ where: { usuarioId: users.uno.id } });
  await runAutomation({ usuarioIds: [users.uno.id] });
  assert.ok(
    (await loan(active.id)).fechaAvisoVencimiento,
    'El aviso próximo a vencer debe registrar la fecha de envío.',
  );
  assert.ok((await prisma.notificacion.count({ where: { usuarioId: users.uno.id } })) > before);
  const after = await prisma.notificacion.count({ where: { usuarioId: users.uno.id } });
  await runAutomation({ usuarioIds: [users.uno.id] });
  assert.equal(
    await prisma.notificacion.count({ where: { usuarioId: users.uno.id } }),
    after,
    'El recordatorio debe enviarse una sola vez.',
  );
  await devolver(active.id);
  const notifications = await request('GET', '/notificaciones', { token: users.uno.token });
  assert.ok(notifications.length > 0);
  await request('POST', `/notificaciones/${notifications[0].id}/leer`, { token: users.uno.token });
  await request('POST', `/notificaciones/${notifications[0].id}/leer`, {
    token: users.dos.token,
    status: 404,
  });
  console.log(
    'Liberación automática por inasistencia, avisos y privacidad de notificaciones: correcto.',
  );
}

async function importsAndExports() {
  const matricula = `${prefix}-importado`;
  const correo = `${matricula}@${domain}`;
  const header = 'matricula,nombre,correo,carrera,periodo,estado';
  const row = `${matricula},Alumno importado,${correo},Química,2026-2,ACTIVO`;
  const invalid = await request('POST', '/admin/importar/alumnos', {
    token: users.admin.token,
    body: { formato: 'csv', contenido: `${header}\n${row}\n${row}`, confirmar: true },
  });
  assert.equal(invalid.valido, false);
  assert.ok(invalid.errores.length);
  assert.equal(
    await prisma.usuario.count({ where: { matricula } }),
    0,
    'Una carga con errores no debe escribir registros.',
  );
  const foreign = await request('POST', '/admin/importar/alumnos', {
    token: users.admin.token,
    body: {
      formato: 'csv',
      contenido: `${header}\n${matricula},Alumno externo,${prefix}@example.org,Química,2026-2,ACTIVO`,
      confirmar: false,
    },
  });
  assert.equal(foreign.valido, false);
  const preview = await request('POST', '/admin/importar/alumnos', {
    token: users.admin.token,
    body: { formato: 'csv', contenido: `${header}\n${row}`, confirmar: false },
  });
  assert.equal(preview.valido, true);
  assert.equal(await prisma.usuario.count({ where: { matricula } }), 0);
  const imported = await request('POST', '/admin/importar/alumnos', {
    token: users.admin.token,
    body: { formato: 'csv', contenido: `${header}\n${row}`, confirmar: true },
  });
  assert.equal(imported.valido, true);
  assert.equal(imported.credenciales.length, 1);
  const importedUser = await prisma.usuario.findUnique({ where: { matricula } });
  const temporary = await login(importedUser, imported.credenciales[0].password);
  await request('GET', '/materiales', { token: temporary, status: 403 });
  await request('POST', '/password', {
    token: temporary,
    body: { passwordActual: imported.credenciales[0].password, passwordNuevo: password },
  });
  const permanent = await login(importedUser);
  await request('GET', '/materiales', { token: permanent });
  const repeat = await request('POST', '/admin/importar/alumnos', {
    token: users.admin.token,
    body: { formato: 'csv', contenido: `${header}\n${row}`, confirmar: true },
  });
  assert.equal(repeat.resumen.actualizados, 1);
  assert.equal(repeat.credenciales.length, 0);
  const caseRepeat = await request('POST', '/admin/importar/alumnos', {
    token: users.admin.token,
    body: {
      formato: 'csv',
      contenido: `${header}\n${row.replace(matricula, matricula.toUpperCase())}`,
      confirmar: true,
    },
  });
  assert.equal(caseRepeat.resumen.actualizados, 1);
  assert.equal(caseRepeat.resumen.creados, 0);
  assert.equal(
    await prisma.usuario.count({
      where: { matricula: { equals: matricula, mode: 'insensitive' } },
    }),
    1,
    'Cambiar mayúsculas no debe duplicar al alumno.',
  );

  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Materiales');
  sheet.addRow(['nombre', 'categoria', 'caracteristicas', 'cantidad', 'maxHoras']);
  const importedName = `${prefix} Excel`;
  sheet.addRow([importedName, prefix, 'Equipo importado para pruebas', 2, 6]);
  const contents = Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
  const preflight = await request('POST', '/admin/importar/materiales', {
    token: users.admin.token,
    body: { formato: 'xlsx', contenido: contents, confirmar: false },
  });
  assert.equal(preflight.valido, true);
  assert.equal(await prisma.material.count({ where: { nombre: importedName } }), 0);
  await request('POST', '/admin/importar/materiales', {
    token: users.admin.token,
    body: { formato: 'xlsx', contenido: contents, confirmar: true },
  });
  await request('POST', '/admin/importar/materiales', {
    token: users.admin.token,
    body: { formato: 'xlsx', contenido: contents, confirmar: true },
  });
  const materialImportado = await prisma.material.findFirst({
    where: { nombre: importedName },
    include: { piezas: true },
  });
  assert.equal(materialImportado.cantidadTotal, 4);
  assert.equal(
    materialImportado.piezas.length,
    4,
    'La segunda carga debe sumar unidades sin duplicar el material.',
  );
  assert.equal(await prisma.material.count({ where: { nombre: importedName } }), 1);
  sheet.getCell('A2').value = { formula: '1+1', result: 2 };
  const formula = Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
  await request('POST', '/admin/importar/materiales', {
    token: users.admin.token,
    status: 400,
    body: { formato: 'xlsx', contenido: formula, confirmar: true },
  });
  assert.equal(
    (await prisma.material.findUnique({ where: { id: materialImportado.id } })).cantidadTotal,
    4,
  );

  const pdf = await request(
    'GET',
    `/admin/reportes?tipo=prestamos&usuarioId=${users.uno.id}&formato=pdf`,
    { token: users.admin.token, binary: true },
  );
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const xlsx = await request(
    'GET',
    `/admin/reportes?tipo=prestamos&usuarioId=${users.uno.id}&formato=xlsx`,
    { token: users.admin.token, binary: true },
  );
  assert.equal(xlsx.subarray(0, 2).toString(), 'PK');
  const exportedBook = new ExcelJS.Workbook();
  await exportedBook.xlsx.load(xlsx);
  assert.ok(exportedBook.worksheets[0].rowCount > 1);
  console.log(
    'Importación CSV/Excel, validación previa, contraseñas temporales y exportación PDF/Excel: correcto.',
  );
}

async function semesterReplacementRollback() {
  // La ruta real hace una sustitución global de semestre. Se ejecuta dentro de una
  // transacción externa que SIEMPRE se revierte para no deshabilitar cuentas ajenas.
  // Sólo este proceso de pruebas redirige temporalmente el método del cliente;
  // el servidor de la aplicación y su lógica permanecen sin cambios.
  const userSelect = {
    id: true,
    activo: true,
    sessionVersion: true,
    nombre: true,
    correo: true,
    carrera: true,
    periodo: true,
  };
  const previousUsers = await prisma.usuario.findMany({
    select: userSelect,
    orderBy: { id: 'asc' },
  });
  const previousPadron = await prisma.padron.findMany({ orderBy: { matricula: 'asc' } });
  const previousAuditCount = await prisma.actividad.count({ where: { usuarioId: users.admin.id } });
  const historical = await prisma.prestamo.findFirst({
    where: { usuarioId: users.dos.id },
    orderBy: { id: 'asc' },
  });
  assert.ok(historical, 'La prueba de semestre necesita historial del alumno ausente.');
  const originalTransaction = prisma.$transaction;
  const rollback = new Error('Reversión deliberada de la sustitución de semestre de prueba');
  let intercepted = 0;
  try {
    await originalTransaction.call(
      prisma,
      async (tx) => {
        prisma.$transaction = async (fn) => {
          assert.equal(
            typeof fn,
            'function',
            'Esta prueba permite únicamente transacciones funcionales dentro del rollback.',
          );
          intercepted++;
          return fn(tx);
        };
        try {
          const contenido = `matricula,nombre,correo,carrera,periodo,estado\n${users.uno.matricula},${users.uno.nombre},${users.uno.correo},Química,2027-1,ACTIVO`;
          const result = await request('POST', '/admin/importar/alumnos', {
            token: users.admin.token,
            body: { formato: 'csv', contenido, confirmar: true, semestreCompleto: true },
          });
          assert.equal(result.valido, true);
          assert.ok(result.resumen.inactivados >= 1);
          assert.equal((await tx.usuario.findUnique({ where: { id: users.uno.id } })).activo, true);
          const absent = await tx.usuario.findUnique({ where: { id: users.dos.id } });
          assert.equal(absent.activo, false);
          assert.equal(absent.sessionVersion, users.dos.sessionVersion + 1);
          assert.equal(
            (await tx.padron.findUnique({ where: { matricula: users.dos.matricula } })).activo,
            false,
          );
          assert.deepEqual(
            await tx.prestamo.findUnique({ where: { id: historical.id } }),
            historical,
            'El historial del alumno ausente debe conservarse sin modificaciones.',
          );
          assert.ok(
            intercepted > 0,
            'La importación debe permanecer dentro de la transacción externa.',
          );
        } finally {
          prisma.$transaction = originalTransaction;
        }
        throw rollback;
      },
      { isolationLevel: 'Serializable', maxWait: 10000, timeout: 60000 },
    );
    assert.fail('La sustitución de semestre de prueba nunca debe confirmarse.');
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    prisma.$transaction = originalTransaction;
  }
  assert.deepEqual(
    await prisma.usuario.findMany({ select: userSelect, orderBy: { id: 'asc' } }),
    previousUsers,
    'El rollback debe conservar todas las cuentas, incluidas las reales.',
  );
  assert.deepEqual(await prisma.padron.findMany({ orderBy: { matricula: 'asc' } }), previousPadron);
  assert.equal(
    await prisma.actividad.count({ where: { usuarioId: users.admin.id } }),
    previousAuditCount,
    'La importación revertida no debe persistir una entrada de actividad.',
  );
  console.log(
    'RN22: sustitución de semestre e historial comprobados con rollback; cuentas existentes conservadas.',
  );
}

async function auditAndRevocation() {
  const logs = await request('GET', '/admin/actividad?modulo=PRESTAMOS', {
    token: users.admin.token,
  });
  const entries = Array.isArray(logs) ? logs : logs.registros;
  assert.ok(entries.some((log) => log.usuarioId === users.encargado.id));
  const log = await prisma.actividad.findFirst({
    where: { usuarioId: users.admin.id },
    orderBy: { id: 'desc' },
  });
  assert.ok(log);
  const dayParts = localParts(log.fecha);
  const localDay = `${dayParts.year}-${String(dayParts.month).padStart(2, '0')}-${String(dayParts.day).padStart(2, '0')}`;
  const dayLogs = await request(
    'GET',
    `/admin/actividad?desde=${localDay}&hasta=${localDay}&usuarioId=${users.admin.id}`,
    { token: users.admin.token },
  );
  assert.ok(
    dayLogs.some((entry) => entry.id === log.id),
    'El filtro por día debe usar el calendario institucional.',
  );
  await assert.rejects(() =>
    prisma.actividad.update({ where: { id: log.id }, data: { accion: 'ALTERACION_PROHIBIDA' } }),
  );
  await assert.rejects(() => prisma.actividad.delete({ where: { id: log.id } }));
  assert.equal((await prisma.actividad.findUnique({ where: { id: log.id } })).accion, log.accion);
  const oldToken = users.dos.token;
  await request('PATCH', `/admin/usuarios/${users.dos.id}`, {
    token: users.admin.token,
    body: { activo: false },
  });
  await request('GET', '/materiales', { token: oldToken, status: [401, 403] });
  await request('POST', '/login', { body: { correo: users.dos.correo, password }, status: 403 });
  await request('PATCH', `/admin/usuarios/${users.dos.id}`, {
    token: users.admin.token,
    body: { activo: true },
  });
  await request('GET', '/materiales', { token: oldToken, status: 401 });
  users.dos.token = await login(users.dos);
  await request('GET', '/materiales', { token: users.dos.token });
  const newStaff = await request('POST', '/admin/usuarios', {
    token: users.admin.token,
    status: 201,
    body: { nombre: `${prefix} Encargado creado`, correo: `${prefix}-nuevo@${domain}`, password },
  });
  extraUserIds.add(newStaff.id);
  const staffToken = await login(newStaff);
  await request('GET', '/admin/configuracion', { token: staffToken, status: 403 });
  await request('PATCH', `/admin/usuarios/${newStaff.id}`, {
    token: users.admin.token,
    body: { activo: false },
  });
  await request('GET', '/operacion/prestamos', { token: staffToken, status: [401, 403] });
  console.log('Bitácora inmutable y revocación inmediata de sesiones deshabilitadas: correcto.');
}

async function cleanup() {
  const accounts = await prisma.usuario.findMany({
    where: { OR: [{ matricula: { startsWith: prefix } }, { id: { in: [...extraUserIds] } }] },
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
    prisma.aviso.deleteMany({ where: { titulo: { startsWith: prefix } } }),
    prisma.usuario.deleteMany({ where: { id: { in: userIds } } }),
    prisma.padron.deleteMany({ where: { matricula: { startsWith: prefix } } }),
  ]);
}

(async () => {
  try {
    await prisma.$connect();
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    await fixtureUsers();
    await authChecks();
    await stockAndFifo();
    await substitutionMaintenanceAndExpiry();
    await previousDefect();
    await incidentAndAgreement();
    await automationChecks();
    await importsAndExports();
    await additionalGuards();
    await semesterReplacementRollback();
    await auditAndRevocation();
    console.log(`Prueba integral completada: ${checks} respuestas HTTP verificadas.`);
  } catch (error) {
    console.error('Falló la prueba integral:', error.stack || error.message);
    process.exitCode = 1;
  } finally {
    try {
      await cleanup();
      console.log('Fixtures eliminadas; la auditoría inmutable de las pruebas se conserva.');
    } catch (error) {
      console.error('No se pudieron limpiar las fixtures:', error.message);
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
