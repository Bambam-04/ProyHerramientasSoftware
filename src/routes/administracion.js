const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID, randomBytes } = require('node:crypto');
const {
  prisma,
  asyncHandler,
  fail,
  audit,
  notify,
  transaction,
  config,
  eligibility,
  parseDateTime,
  notifyAvailability,
} = require('../lib/core');
const { auth, requireRoles } = require('../lib/auth');
const { parseImport, normal } = require('../lib/imports');
const { buildReport, sendReport, incidentList, dateRange, queryId } = require('../lib/reportes');

const router = express.Router();
router.use(auth, requireRoles('ADMIN'));
const DOMAIN = (process.env.DOMINIO_INSTITUCIONAL || 'uabc.edu.mx').toLowerCase();
const USER_FIELDS = {
  id: true,
  matricula: true,
  nombre: true,
  correo: true,
  rol: true,
  activo: true,
  bloqueo: true,
  carrera: true,
  periodo: true,
  fotografia: true,
  debeCambiarPassword: true,
  creadoEn: true,
};
const GOOD_CONDITIONS = ['BUENO', 'INTEGRO', 'RAYADO', 'ASTILLADO'];
const CONDITIONS = [...GOOD_CONDITIONS, 'DANADO', 'ROTO', 'PERDIDO'];

function id(value, label = 'identificador') {
  if (!/^[1-9]\d*$/.test(String(value)) || Number(value) > 2147483647)
    fail(400, `El ${label} debe ser un número entero positivo.`);
  return Number(value);
}
function text(value, label, { max = 500, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    (!optional && !value.trim()) ||
    value.length > max
  )
    fail(400, `${label}: indica texto válido de hasta ${max} caracteres.`);
  return value.trim();
}
function integer(value, label, min = 1, max = 10000) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !/^\d+$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    fail(400, `${label}: indica un entero entre ${min} y ${max}.`);
  return Number(value);
}
function boolean(value, label) {
  if (typeof value !== 'boolean') fail(400, `${label} debe ser verdadero o falso.`);
  return value;
}
function email(value, institutional = false) {
  const mail = text(value, 'Correo', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || (institutional && !mail.endsWith(`@${DOMAIN}`)))
    fail(
      400,
      institutional ? `Usa un correo institucional @${DOMAIN}.` : 'Indica un correo válido.',
    );
  return mail;
}
function password(value) {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    Buffer.byteLength(value, 'utf8') > 72 ||
    !/[A-Za-z]/.test(value) ||
    !/\d/.test(value)
  )
    fail(400, 'La contraseña requiere al menos 8 caracteres, letras y números, y hasta 72 bytes.');
  return value;
}
function photo(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const url = text(value, 'Fotografía', { max: 500000 });
  if (
    !/^https:\/\/[^\s<>]+$/i.test(url) &&
    !/^\/[^/\s<>][^\s<>]*$/.test(url) &&
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)
  )
    fail(
      400,
      'La fotografía debe usar una URL HTTPS, ruta local o imagen PNG/JPEG/WebP en base64.',
    );
  return url;
}
function materialData(body, partial = false) {
  const result = {};
  for (const [key, label, max] of [
    ['nombre', 'Nombre', 150],
    ['categoria', 'Categoría', 100],
    ['caracteristicas', 'Características', 3000],
  ]) {
    if (!partial || body[key] !== undefined) result[key] = text(body[key], label, { max });
  }
  if (!partial || body.maxHoras !== undefined)
    result.maxHoras = integer(body.maxHoras ?? 24, 'Tiempo máximo de préstamo', 1, 8760);
  if (body.fotografia !== undefined) result.fotografia = photo(body.fotografia);
  if (!partial || body.cantidadTotal !== undefined)
    result.cantidadTotal = integer(body.cantidadTotal, 'Cantidad total', 0, 10000);
  if (body.estado !== undefined) {
    if (!['ACTIVO', 'MANTENIMIENTO', 'BAJA'].includes(body.estado))
      fail(400, 'El estado del material no es válido.');
    result.estado = body.estado;
  }
  return result;
}

async function addPieces(tx, materialId, count, state = 'DISPONIBLE') {
  const data = Array.from({ length: count }, () => ({
    materialId,
    codigo: `CIMA-${materialId}-${randomUUID().slice(0, 12).toUpperCase()}`,
    estado: state,
    condicion: 'INTEGRO',
  }));
  if (data.length) await tx.pieza.createMany({ data });
}
// Al reactivar un material en mantenimiento, sus piezas íntegras vuelven a estar disponibles.
// Las piezas con daño registrado (rayado, astillado, dañado, roto) permanecen en
// mantenimiento hasta que el administrador las revise individualmente (RF-SIS-02.4).
async function releaseMaintenance(tx, materialId) {
  const released = await tx.pieza.updateMany({
    where: { materialId, estado: 'MANTENIMIENTO', condicion: { in: ['INTEGRO', 'BUENO'] } },
    data: { estado: 'DISPONIBLE' },
  });
  const pending = await tx.pieza.count({ where: { materialId, estado: 'MANTENIMIENTO' } });
  return { liberadas: released.count, enRevision: pending };
}
async function syncQuantity(tx, materialId) {
  const cantidadTotal = await tx.pieza.count({
    where: { materialId, estado: { notIn: ['BAJA', 'PERDIDA'] } },
  });
  await tx.material.update({ where: { id: materialId }, data: { cantidadTotal } });
}

router.get(
  '/usuarios',
  asyncHandler(async (req, res) => {
    const usuarios = await prisma.usuario.findMany({
      select: USER_FIELDS,
      orderBy: { nombre: 'asc' },
    });
    res.json(usuarios);
  }),
);

router.post(
  '/usuarios',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (body.rol && body.rol !== 'ENCARGADO')
      fail(400, 'Este formulario crea exclusivamente cuentas de Encargado de Ventanilla.');
    const nombre = text(body.nombre, 'Nombre', { max: 200 });
    const correo = email(body.correo);
    const passwordHash = await bcrypt.hash(password(body.password), 10);
    const usuario = await transaction(async (tx) => {
      const created = await tx.usuario.create({
        data: {
          matricula: `ENC-${randomUUID()}`,
          nombre,
          correo,
          passwordHash,
          rol: 'ENCARGADO',
          activo: true,
        },
        select: USER_FIELDS,
      });
      await audit(tx, req.usuario, 'ALTA_ENCARGADO', 'USUARIOS', { usuarioId: created.id, correo });
      return created;
    });
    res.status(201).json(usuario);
  }),
);

router.patch(
  '/usuarios/:id',
  asyncHandler(async (req, res) => {
    const usuarioId = id(req.params.id);
    const body = req.body || {};
    const previous = await prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: USER_FIELDS,
    });
    if (!previous) fail(404, 'La cuenta no existe.');
    const data = {};
    if (body.rol !== undefined && body.rol !== previous.rol)
      fail(400, 'No se permite modificar el rol de una cuenta existente.');
    if (body.nombre !== undefined) data.nombre = text(body.nombre, 'Nombre', { max: 200 });
    if (body.correo !== undefined)
      data.correo = email(body.correo, ['ALUMNO', 'DOCENTE'].includes(previous.rol));
    if (body.activo !== undefined) data.activo = boolean(body.activo, 'Activo');
    if (body.bloqueo !== undefined) data.bloqueo = boolean(body.bloqueo, 'Bloqueo');
    for (const key of ['carrera', 'periodo'])
      if (body[key] !== undefined) data[key] = text(body[key], key, { max: 150, optional: true });
    if (body.fotografia !== undefined) data.fotografia = photo(body.fotografia);
    if (body.password !== undefined) {
      data.passwordHash = await bcrypt.hash(password(body.password), 10);
      data.debeCambiarPassword = true;
      data.intentos = 0;
      data.bloqueadoHasta = null;
    }
    if (!Object.keys(data).length) fail(400, 'No se recibieron cambios para la cuenta.');
    if (data.passwordHash || data.correo || data.activo !== undefined || data.bloqueo !== undefined)
      data.sessionVersion = { increment: 1 };
    if (usuarioId === req.usuario.id && (data.activo === false || data.bloqueo === true))
      fail(409, 'No puedes deshabilitar ni bloquear tu propia cuenta administrativa.');
    const usuario = await transaction(async (tx) => {
      const result = await tx.usuario.update({
        where: { id: usuarioId },
        data,
        select: USER_FIELDS,
      });
      if (['ALUMNO', 'DOCENTE'].includes(result.rol)) {
        const padron = await tx.padron.findFirst({
          where: { matricula: { equals: result.matricula, mode: 'insensitive' } },
        });
        if (padron)
          await tx.padron.update({
            where: { matricula: padron.matricula },
            data: {
              nombre: result.nombre,
              correo: result.correo,
              activo: result.activo,
              carrera: result.carrera,
              periodo: result.periodo,
            },
          });
      }
      await audit(tx, req.usuario, 'MODIFICAR_USUARIO', 'USUARIOS', {
        usuarioId,
        campos: Object.keys(data).filter((k) => k !== 'passwordHash'),
        passwordRestablecida: !!data.passwordHash,
      });
      return result;
    });
    res.json(usuario);
  }),
);

router.get(
  '/padron',
  asyncHandler(async (req, res) =>
    res.json(await prisma.padron.findMany({ orderBy: { nombre: 'asc' } })),
  ),
);

router.get(
  '/materiales',
  asyncHandler(async (req, res) => {
    const materiales = await prisma.material.findMany({
      include: { piezas: { orderBy: { codigo: 'asc' } } },
      orderBy: { nombre: 'asc' },
    });
    res.json(
      materiales.map((m) => ({
        ...m,
        disponibles:
          m.estado === 'ACTIVO' ? m.piezas.filter((p) => p.estado === 'DISPONIBLE').length : 0,
      })),
    );
  }),
);

router.post(
  '/materiales',
  asyncHandler(async (req, res) => {
    const data = materialData(req.body || {});
    const material = await transaction(async (tx) => {
      if (
        await tx.material.findFirst({
          where: {
            nombre: { equals: data.nombre, mode: 'insensitive' },
            categoria: { equals: data.categoria, mode: 'insensitive' },
          },
        })
      )
        fail(
          409,
          'Ya existe ese material en la categoría. Edita su cantidad o utiliza la carga masiva.',
        );
      const m = await tx.material.create({ data });
      await addPieces(
        tx,
        m.id,
        data.cantidadTotal,
        data.estado === 'MANTENIMIENTO'
          ? 'MANTENIMIENTO'
          : data.estado === 'BAJA'
            ? 'BAJA'
            : 'DISPONIBLE',
      );
      if (data.estado === 'BAJA') await syncQuantity(tx, m.id);
      await audit(tx, req.usuario, 'ALTA_MATERIAL', 'MATERIALES', {
        materialId: m.id,
        nombre: m.nombre,
        cantidad: data.cantidadTotal,
      });
      return tx.material.findUnique({ where: { id: m.id }, include: { piezas: true } });
    });
    res.status(201).json(material);
  }),
);

router.patch(
  '/materiales/:id',
  asyncHandler(async (req, res) => {
    const materialId = id(req.params.id);
    const data = materialData(req.body || {}, true);
    if (!Object.keys(data).length) fail(400, 'No se recibieron cambios para el material.');
    const result = await transaction(async (tx) => {
      const previous = await tx.material.findUnique({
        where: { id: materialId },
        include: { piezas: true },
      });
      if (!previous) fail(404, 'El material no existe.');
      const busy = previous.piezas.filter((p) => ['RESERVADA', 'PRESTADA'].includes(p.estado));
      if (data.estado && data.estado !== previous.estado && busy.length)
        fail(
          409,
          'No se puede cambiar el estado de un material con piezas reservadas o prestadas.',
        );
      const duplicate = await tx.material.findFirst({
        where: {
          id: { not: materialId },
          nombre: { equals: data.nombre ?? previous.nombre, mode: 'insensitive' },
          categoria: { equals: data.categoria ?? previous.categoria, mode: 'insensitive' },
        },
      });
      if (duplicate) fail(409, 'Ya existe otro material con ese nombre y categoría.');
      const active = previous.piezas.filter((p) => !['BAJA', 'PERDIDA'].includes(p.estado));
      if (data.cantidadTotal !== undefined) {
        const delta = data.cantidadTotal - active.length;
        if (delta > 0)
          await addPieces(
            tx,
            materialId,
            delta,
            (data.estado ?? previous.estado) === 'ACTIVO' ? 'DISPONIBLE' : 'MANTENIMIENTO',
          );
        if (delta < 0) {
          const removable = active.filter((p) => p.estado === 'DISPONIBLE');
          if (removable.length < -delta)
            fail(
              409,
              'La cantidad sólo puede disminuir dando de baja piezas disponibles. Resuelve primero reservas, préstamos o mantenimiento.',
            );
          await tx.pieza.updateMany({
            where: {
              id: { in: removable.slice(0, -delta).map((p) => p.id) },
              estado: 'DISPONIBLE',
            },
            data: { estado: 'BAJA' },
          });
        }
      }
      if (data.estado === 'BAJA')
        await tx.pieza.updateMany({
          where: { materialId, estado: { notIn: ['BAJA', 'PERDIDA'] } },
          data: { estado: 'BAJA' },
        });
      if (data.estado === 'MANTENIMIENTO')
        await tx.pieza.updateMany({
          where: { materialId, estado: 'DISPONIBLE' },
          data: { estado: 'MANTENIMIENTO' },
        });
      const reactivacion =
        data.estado === 'ACTIVO' && previous.estado === 'MANTENIMIENTO'
          ? await releaseMaintenance(tx, materialId)
          : undefined;
      await tx.material.update({ where: { id: materialId }, data });
      await syncQuantity(tx, materialId);
      await audit(tx, req.usuario, 'MODIFICAR_MATERIAL', 'MATERIALES', {
        materialId,
        cambios: { ...data, fotografia: data.fotografia ? '(imagen)' : data.fotografia },
        ...(reactivacion ? { reactivacion } : {}),
      });
      if (
        (data.estado ?? previous.estado) === 'ACTIVO' &&
        ((data.cantidadTotal || 0) > active.length || previous.estado !== 'ACTIVO')
      )
        await notifyAvailability(tx, materialId);
      const material = await tx.material.findUnique({
        where: { id: materialId },
        include: { piezas: true },
      });
      return reactivacion ? { ...material, reactivacion } : material;
    });
    res.json(result);
  }),
);

router.post(
  '/materiales/:id/baja',
  asyncHandler(async (req, res) => {
    const materialId = id(req.params.id);
    await transaction(async (tx) => {
      const material = await tx.material.findUnique({ where: { id: materialId } });
      if (!material) fail(404, 'El material no existe.');
      if (material.estado === 'BAJA') fail(409, 'El material ya fue dado de baja.');
      if (
        await tx.pieza.count({ where: { materialId, estado: { in: ['RESERVADA', 'PRESTADA'] } } })
      )
        fail(409, 'No se puede dar de baja material reservado o prestado.');
      await tx.pieza.updateMany({
        where: { materialId, estado: { notIn: ['BAJA', 'PERDIDA'] } },
        data: { estado: 'BAJA' },
      });
      await tx.material.update({
        where: { id: materialId },
        data: { estado: 'BAJA', cantidadTotal: 0 },
      });
      await audit(tx, req.usuario, 'BAJA_MATERIAL', 'MATERIALES', {
        materialId,
        nombre: material.nombre,
      });
    });
    res.json({ mensaje: 'Material dado de baja; su historial se conserva.' });
  }),
);

router.patch(
  '/piezas/:id',
  asyncHandler(async (req, res) => {
    const piezaId = id(req.params.id);
    const body = req.body || {};
    if (!['DISPONIBLE', 'MANTENIMIENTO', 'BAJA', 'PERDIDA'].includes(body.estado))
      fail(400, 'Selecciona Disponible, Mantenimiento, Baja o Perdida.');
    if (body.condicion !== undefined && !CONDITIONS.includes(body.condicion))
      fail(400, 'La condición física no es válida.');
    const result = await transaction(async (tx) => {
      const pieza = await tx.pieza.findUnique({
        where: { id: piezaId },
        include: { material: true },
      });
      if (!pieza) fail(404, 'La pieza no existe.');
      if (['RESERVADA', 'PRESTADA'].includes(pieza.estado))
        fail(409, 'Una pieza reservada o prestada se gestiona desde ventanilla.');
      const condicion = body.estado === 'PERDIDA' ? 'PERDIDO' : (body.condicion ?? pieza.condicion);
      if (condicion === 'PERDIDO' && !['PERDIDA', 'BAJA'].includes(body.estado))
        fail(
          409,
          'Para registrar una pieza recuperada, indica también su condición física después de revisarla.',
        );
      if (body.estado === 'DISPONIBLE' && !GOOD_CONDITIONS.includes(condicion))
        fail(409, 'Registra primero una condición segura después de revisar o reparar la pieza.');
      if (body.estado === 'DISPONIBLE' && pieza.material.estado !== 'ACTIVO')
        fail(409, 'Activa el material del catálogo antes de liberar sus piezas.');
      const updated = await tx.pieza.update({
        where: { id: piezaId },
        data: { estado: body.estado, condicion },
      });
      await syncQuantity(tx, pieza.materialId);
      await audit(tx, req.usuario, 'MODIFICAR_PIEZA', 'MATERIALES', {
        piezaId,
        codigo: pieza.codigo,
        anterior: pieza.estado,
        estado: body.estado,
        condicion,
      });
      if (body.estado === 'DISPONIBLE' && pieza.estado !== 'DISPONIBLE')
        await notifyAvailability(tx, pieza.materialId);
      return updated;
    });
    res.json(result);
  }),
);

async function validateStudents(tx, records, inputErrors) {
  const errors = [...inputErrors];
  const mats = new Set();
  const mails = new Set();
  const normalized = [];
  for (const r of records) {
    try {
      const matricula = text(r.matricula, 'Matrícula', { max: 50 });
      if (!/^[A-Za-z0-9-]+$/.test(matricula))
        fail(400, 'La matrícula sólo puede contener letras, números y guiones.');
      const correo = email(r.correo, true);
      const nombre = text(r.nombre, 'Nombre', { max: 200 });
      const carrera = text(r.carrera, 'Carrera', { max: 150 });
      const periodo = text(r.periodo, 'Periodo o grupo', { max: 150 });
      const state = normal(r.estado);
      if (!['activo', 'activa', 'inactivo', 'inactiva', 'true', 'false', '1', '0'].includes(state))
        fail(400, 'Estado debe ser ACTIVO o INACTIVO.');
      const activo = ['activo', 'activa', 'true', '1'].includes(state);
      const matriculaKey = matricula.toLowerCase();
      if (mats.has(matriculaKey))
        fail(400, 'La matrícula está duplicada dentro del archivo (sin distinguir mayúsculas).');
      if (mails.has(correo)) fail(400, 'El correo está duplicado dentro del archivo.');
      mats.add(matriculaKey);
      mails.add(correo);
      if (r.password) password(r.password);
      normalized.push({
        fila: r.fila,
        matricula,
        correo,
        nombre,
        carrera,
        periodo,
        activo,
        password: r.password || undefined,
      });
    } catch (error) {
      errors.push({ fila: r.fila, error: error.message });
    }
  }
  const [users, enrolled] = await Promise.all([
    tx.usuario.findMany({
      where: {
        OR: [{ matricula: { in: [...mats], mode: 'insensitive' } }, { correo: { in: [...mails] } }],
      },
      select: USER_FIELDS,
    }),
    tx.padron.findMany({ where: { matricula: { in: [...mats], mode: 'insensitive' } } }),
  ]);
  const byFold = new Map();
  const byPadron = new Map();
  const ambiguous = new Set();
  for (const [rows, map] of [
    [users, byFold],
    [enrolled, byPadron],
  ])
    for (const row of rows) {
      const key = row.matricula.toLowerCase();
      if (map.has(key)) ambiguous.add(key);
      else map.set(key, row);
    }
  const byMat = new Map();
  const byMail = new Map(users.map((u) => [u.correo, u]));
  for (const r of normalized) {
    const key = r.matricula.toLowerCase();
    const current = byFold.get(key);
    const previousPadron = byPadron.get(key);
    const mailOwner = byMail.get(r.correo);
    // Se conserva la escritura de la matrícula existente; no se renombra su historial.
    r.matricula = current?.matricula ?? previousPadron?.matricula ?? r.matricula;
    if (current) byMat.set(r.matricula, current);
    if (ambiguous.has(key))
      errors.push({
        fila: r.fila,
        error:
          'Existen matrículas históricas duplicadas que sólo difieren en mayúsculas. Corrige esos registros antes de importar.',
      });
    if (current && !['ALUMNO', 'DOCENTE'].includes(current.rol))
      errors.push({
        fila: r.fila,
        error: 'La matrícula pertenece a una cuenta de personal y no puede importarse como alumno.',
      });
    if (previousPadron && !['ALUMNO', 'DOCENTE'].includes(previousPadron.rol))
      errors.push({
        fila: r.fila,
        error: 'La matrícula pertenece a personal del padrón y no puede importarse como alumno.',
      });
    if (mailOwner && mailOwner.matricula.toLowerCase() !== key)
      errors.push({ fila: r.fila, error: 'El correo ya está asignado a otra matrícula.' });
  }
  return { errors, normalized, byMat, byPadron };
}

function importResult(result, additional = {}) {
  const rejectedRows = new Set(result.errors.map((e) => e.fila));
  const good = result.normalized.filter((r) => !rejectedRows.has(r.fila));
  return {
    valido: result.errors.length === 0,
    errores: result.errors,
    resumen: {
      creados: good.filter((r) => !result.byKey.has(result.key(r))).length,
      actualizados: good.filter((r) => result.byKey.has(result.key(r))).length,
      rechazados: rejectedRows.size,
      inactivados: 0,
    },
    registros: result.normalized.map(({ password: ignored, ...r }) => r),
    ...additional,
  };
}

router.post(
  '/importar/alumnos',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (body.confirmar !== undefined) boolean(body.confirmar, 'Confirmar');
    if (body.semestreCompleto !== undefined) boolean(body.semestreCompleto, 'Semestre completo');
    const { records, errors } = await parseImport(body, 'alumnos');
    const checked = await validateStudents(prisma, records, errors);
    const shape = (check) => ({ ...check, byKey: check.byMat, key: (r) => r.matricula });
    const preview = importResult(shape(checked));
    if (body.semestreCompleto && preview.valido)
      preview.resumen.inactivados = await prisma.usuario.count({
        where: {
          rol: 'ALUMNO',
          activo: true,
          matricula: { notIn: checked.normalized.map((r) => r.matricula), mode: 'insensitive' },
        },
      });
    if (!body.confirmar || !preview.valido) return res.json(preview);
    // Preparar hashes fuera de la transacción evita mantener bloqueos durante bcrypt.
    const prepared = new Map();
    const credentialRows = [];
    for (const r of checked.normalized) {
      if (!checked.byMat.has(r.matricula) || r.password) {
        const pass = r.password || `Cima-${randomBytes(9).toString('base64url')}9`;
        prepared.set(r.matricula.toLowerCase(), await bcrypt.hash(pass, 10));
        if (!checked.byMat.has(r.matricula))
          credentialRows.push({ matricula: r.matricula, correo: r.correo, password: pass });
      }
    }
    const result = await transaction(async (tx) => {
      const fresh = await validateStudents(tx, records, errors);
      if (fresh.errors.length) return importResult(shape(fresh));
      let inactivados = 0;
      if (body.semestreCompleto) {
        const included = fresh.normalized.map((r) => r.matricula);
        const absent = await tx.usuario.updateMany({
          where: {
            rol: 'ALUMNO',
            activo: true,
            matricula: { notIn: included, mode: 'insensitive' },
          },
          data: { activo: false, sessionVersion: { increment: 1 } },
        });
        inactivados = absent.count;
        await tx.padron.updateMany({
          where: { rol: 'ALUMNO', matricula: { notIn: included, mode: 'insensitive' } },
          data: { activo: false },
        });
      }
      const createdMats = new Map();
      for (const r of fresh.normalized) {
        const data = {
          nombre: r.nombre,
          correo: r.correo,
          carrera: r.carrera,
          periodo: r.periodo,
          activo: r.activo,
        };
        const padronMatricula =
          fresh.byPadron.get(r.matricula.toLowerCase())?.matricula ?? r.matricula;
        await tx.padron.upsert({
          where: { matricula: padronMatricula },
          create: { matricula: r.matricula, rol: 'ALUMNO', ...data },
          update: data,
        });
        const current = fresh.byMat.get(r.matricula);
        if (current) {
          if (r.password)
            Object.assign(data, {
              passwordHash: prepared.get(r.matricula.toLowerCase()),
              debeCambiarPassword: true,
              intentos: 0,
              bloqueadoHasta: null,
            });
          if (current.activo !== r.activo || current.correo !== r.correo || r.password)
            data.sessionVersion = { increment: 1 };
          await tx.usuario.update({ where: { id: current.id }, data });
        } else {
          if (!prepared.get(r.matricula.toLowerCase()))
            fail(409, 'La lista cambió durante la carga. Valida nuevamente el archivo.');
          await tx.usuario.create({
            data: {
              matricula: r.matricula,
              rol: 'ALUMNO',
              ...data,
              passwordHash: prepared.get(r.matricula.toLowerCase()),
              debeCambiarPassword: true,
            },
          });
          createdMats.set(r.matricula.toLowerCase(), r.matricula);
        }
      }
      await audit(tx, req.usuario, 'IMPORTAR_ALUMNOS', 'USUARIOS', {
        registros: fresh.normalized.length,
        semestreCompleto: !!body.semestreCompleto,
        inactivados,
        creados: createdMats.size,
      });
      const output = importResult(shape(fresh));
      output.resumen.inactivados = inactivados;
      output.credenciales = credentialRows
        .filter((r) => createdMats.has(r.matricula.toLowerCase()))
        .map((r) => ({ ...r, matricula: createdMats.get(r.matricula.toLowerCase()) }));
      output.mensaje =
        'Lista importada. Las cuentas nuevas están listas para iniciar sesión; entrega sus credenciales temporales por el procedimiento institucional.';
      return output;
    });
    res.json(result);
  }),
);

async function validateMaterials(tx, records, inputErrors) {
  const errors = [...inputErrors];
  const keys = new Set();
  const normalized = [];
  for (const r of records) {
    try {
      const row = materialData({
        nombre: r.nombre,
        categoria: r.categoria,
        caracteristicas: r.caracteristicas,
        cantidadTotal: r.cantidad,
        maxHoras: r.maxHoras,
        fotografia: r.fotografia || undefined,
        estado: r.estado || undefined,
      });
      if (row.cantidadTotal < 1)
        fail(400, 'La carga masiva debe agregar al menos una unidad por material.');
      const key = `${normal(row.nombre)}|${normal(row.categoria)}`;
      if (keys.has(key)) fail(400, 'El material y categoría están duplicados dentro del archivo.');
      keys.add(key);
      normalized.push({ fila: r.fila, ...row });
    } catch (error) {
      errors.push({ fila: r.fila, error: error.message });
    }
  }
  const existing = await tx.material.findMany({
    where: {
      OR: normalized.map((r) => ({
        nombre: { equals: r.nombre, mode: 'insensitive' },
        categoria: { equals: r.categoria, mode: 'insensitive' },
      })),
    },
    include: {
      _count: { select: { piezas: { where: { estado: { in: ['RESERVADA', 'PRESTADA'] } } } } },
    },
  });
  const byKey = new Map();
  for (const m of existing) {
    const key = `${normal(m.nombre)}|${normal(m.categoria)}`;
    if (byKey.has(key)) {
      const row = normalized.find((r) => `${normal(r.nombre)}|${normal(r.categoria)}` === key);
      errors.push({
        fila: row?.fila || 1,
        error:
          'Existen materiales históricos duplicados con el mismo nombre y categoría. Corrige el catálogo antes de importar.',
      });
    }
    byKey.set(key, m);
  }
  for (const row of normalized) {
    const current = byKey.get(`${normal(row.nombre)}|${normal(row.categoria)}`);
    if (current && current.cantidadTotal + row.cantidadTotal > 10000)
      errors.push({
        fila: row.fila,
        error: 'La suma de unidades supera el máximo de 10000 piezas por material.',
      });
    if (current && row.estado && row.estado !== current.estado && current._count.piezas)
      errors.push({
        fila: row.fila,
        error: 'No se puede cambiar el estado de un material con piezas reservadas o prestadas.',
      });
  }
  return { errors, normalized, byKey, key: (r) => `${normal(r.nombre)}|${normal(r.categoria)}` };
}

router.post(
  '/importar/materiales',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (body.confirmar !== undefined) boolean(body.confirmar, 'Confirmar');
    const { records, errors } = await parseImport(body, 'materiales');
    const checked = await validateMaterials(prisma, records, errors);
    const preview = importResult(checked);
    if (!body.confirmar || !preview.valido) return res.json(preview);
    const result = await transaction(async (tx) => {
      const fresh = await validateMaterials(tx, records, errors);
      if (fresh.errors.length) return importResult(fresh);
      for (const row of fresh.normalized) {
        const current = fresh.byKey.get(fresh.key(row));
        const { fila: ignored, cantidadTotal: units, ...metadata } = row;
        let material;
        if (current)
          material = await tx.material.update({
            where: { id: current.id },
            data: {
              ...metadata,
              estado: metadata.estado ?? (current.estado === 'BAJA' ? 'ACTIVO' : current.estado),
            },
          });
        else material = await tx.material.create({ data: { ...metadata, cantidadTotal: units } });
        if (current?.estado === 'MANTENIMIENTO' && material.estado === 'ACTIVO')
          await releaseMaintenance(tx, material.id);
        if (material.estado === 'MANTENIMIENTO')
          await tx.pieza.updateMany({
            where: { materialId: material.id, estado: 'DISPONIBLE' },
            data: { estado: 'MANTENIMIENTO' },
          });
        if (material.estado === 'BAJA')
          await tx.pieza.updateMany({
            where: { materialId: material.id, estado: { notIn: ['BAJA', 'PERDIDA'] } },
            data: { estado: 'BAJA' },
          });
        await addPieces(
          tx,
          material.id,
          units,
          material.estado === 'BAJA'
            ? 'BAJA'
            : material.estado === 'MANTENIMIENTO'
              ? 'MANTENIMIENTO'
              : 'DISPONIBLE',
        );
        await syncQuantity(tx, material.id);
        if (material.estado === 'ACTIVO') await notifyAvailability(tx, material.id);
      }
      await audit(tx, req.usuario, 'IMPORTAR_MATERIALES', 'MATERIALES', {
        registros: fresh.normalized.length,
        unidades: fresh.normalized.reduce((sum, r) => sum + r.cantidadTotal, 0),
      });
      return {
        ...importResult(fresh),
        mensaje: 'Inventario importado; se agregaron unidades a los materiales existentes.',
      };
    });
    res.json(result);
  }),
);

router.get(
  '/configuracion',
  asyncHandler(async (req, res) => res.json(await config())),
);

router.patch(
  '/configuracion',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const data = {};
    for (const [key, min, max] of [
      ['toleranciaMinutos', 1, 240],
      ['anticipacionMaxHoras', 1, 8760],
      ['anticipacionMinMinutos', 0, 525600],
      ['avisoVencimientoMinutos', 1, 1440],
    ])
      if (body[key] !== undefined) data[key] = integer(body[key], key, min, max);
    for (const key of ['horaApertura', 'horaCierre'])
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body[key]))
          fail(400, 'Indica el horario en formato HH:MM de 24 horas.');
        data[key] = body[key];
      }
    if (!Object.keys(data).length) fail(400, 'No se recibieron reglas para actualizar.');
    const result = await transaction(async (tx) => {
      const previous = await config(tx);
      const next = { ...previous, ...data };
      if (next.horaApertura >= next.horaCierre)
        fail(400, 'El horario de apertura debe ser anterior al de cierre.');
      if (next.anticipacionMinMinutos >= next.anticipacionMaxHoras * 60)
        fail(400, 'La anticipación mínima debe ser menor que la máxima.');
      const updated = await tx.configuracion.upsert({
        where: { id: 1 },
        create: { id: 1, ...data },
        update: data,
      });
      await audit(tx, req.usuario, 'CONFIGURAR_REGLAS', 'PRESTAMOS', data);
      return updated;
    });
    res.json(result);
  }),
);

router.get(
  '/incidencias',
  asyncHandler(async (req, res) => res.json(await incidentList(req.query))),
);

router.get(
  '/adeudos',
  asyncHandler(async (req, res) => {
    const where = {};
    const usuarioId = queryId(req.query.usuarioId);
    if (usuarioId) where.usuarioId = usuarioId;
    if (req.query.estado) where.estado = String(req.query.estado);
    const range = dateRange(req.query);
    if (range) where.creadoEn = range;
    res.json(
      await prisma.adeudo.findMany({
        where,
        include: {
          usuario: { select: USER_FIELDS },
          incidencia: {
            include: { piezaPrestamo: { include: { pieza: { include: { material: true } } } } },
          },
          convenios: true,
        },
        orderBy: { creadoEn: 'desc' },
      }),
    );
  }),
);

router.get(
  '/convenios',
  asyncHandler(async (req, res) => {
    const where = {};
    const usuarioId = queryId(req.query.usuarioId);
    if (usuarioId) where.usuarioId = usuarioId;
    if (req.query.estado) where.estado = String(req.query.estado);
    const range = dateRange(req.query);
    if (range) where.fechaCreacion = range;
    res.json(
      await prisma.convenio.findMany({
        where,
        include: {
          usuario: { select: USER_FIELDS },
          adeudo: {
            include: {
              incidencia: {
                include: { piezaPrestamo: { include: { pieza: { include: { material: true } } } } },
              },
            },
          },
        },
        orderBy: { fechaCreacion: 'desc' },
      }),
    );
  }),
);

router.post(
  '/convenios',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const adeudoId = id(body.adeudoId, 'adeudo');
    const descripcion = text(body.descripcion, 'Descripción del convenio', { max: 3000 });
    const fechaLimite = parseDateTime(body.fechaLimite);
    if (fechaLimite <= new Date()) fail(400, 'La fecha límite de reposición debe ser futura.');
    const result = await transaction(async (tx) => {
      if (fechaLimite <= new Date()) fail(400, 'La fecha límite de reposición debe ser futura.');
      const adeudo = await tx.adeudo.findUnique({
        where: { id: adeudoId },
        include: { convenios: true, incidencia: true },
      });
      if (!adeudo) fail(404, 'El adeudo no existe.');
      if (adeudo.estado === 'LIQUIDADO') fail(409, 'El adeudo ya está liquidado.');
      if (adeudo.convenios.some((c) => c.estado === 'ACTIVO' && c.fechaLimite > new Date()))
        fail(409, 'Este adeudo ya tiene un convenio activo dentro de plazo.');
      // Cualquier acuerdo anterior que perdió vigencia queda cerrado como vencido.
      await tx.convenio.updateMany({
        where: { adeudoId, estado: 'ACTIVO', fechaLimite: { lte: new Date() } },
        data: { estado: 'VENCIDO' },
      });
      const convenio = await tx.convenio.create({
        data: { adeudoId, usuarioId: adeudo.usuarioId, descripcion, fechaLimite },
      });
      await tx.adeudo.update({ where: { id: adeudoId }, data: { estado: 'CONVENIO' } });
      await tx.incidencia.update({
        where: { id: adeudo.incidenciaId },
        data: { estado: 'CONVENIO' },
      });
      await audit(tx, req.usuario, 'CREAR_CONVENIO', 'USUARIOS', {
        convenioId: convenio.id,
        adeudoId,
        usuarioId: adeudo.usuarioId,
        fechaLimite,
      });
      await notify(
        tx,
        adeudo.usuarioId,
        'CONVENIO',
        `Se registró el convenio ${convenio.id}. Repón el material antes de ${fechaLimite.toISOString()}; puedes solicitar mientras esté vigente y no tengas otros bloqueos.`,
      );
      return convenio;
    });
    res.status(201).json(result);
  }),
);

async function settleDebt(tx, adeudoId, actor, evidence, notes) {
  const debt = await tx.adeudo.findUnique({
    where: { id: adeudoId },
    include: { incidencia: true, convenios: true },
  });
  if (!debt) fail(404, 'El adeudo no existe.');
  if (debt.estado === 'LIQUIDADO') fail(409, 'El adeudo ya fue liquidado.');
  const fecha = new Date();
  await tx.adeudo.update({
    where: { id: adeudoId },
    data: {
      estado: 'LIQUIDADO',
      liquidadoEn: fecha,
      notas: [notes, `Comprobante o reposición: ${evidence}`].filter(Boolean).join('\n'),
    },
  });
  await tx.incidencia.update({ where: { id: debt.incidenciaId }, data: { estado: 'LIQUIDADA' } });
  await tx.convenio.updateMany({
    where: { adeudoId, estado: { not: 'LIQUIDADO' } },
    data: { estado: 'LIQUIDADO', fechaLiquidacion: fecha, comprobante: evidence },
  });
  const unresolved = await tx.incidencia.count({
    where: { prestamoId: debt.incidencia.prestamoId, estado: { not: 'LIQUIDADA' } },
  });
  if (!unresolved) {
    const closed = await tx.prestamo.updateMany({
      where: { id: debt.incidencia.prestamoId, estado: 'INCIDENCIA' },
      data: { estado: 'DEVUELTO' },
    });
    if (closed.count)
      await audit(tx, actor, 'CERRAR_PRESTAMO_INCIDENCIAS_LIQUIDADAS', 'PRESTAMOS', {
        prestamoId: debt.incidencia.prestamoId,
        ultimoAdeudoId: adeudoId,
      });
  }
  await audit(tx, actor, 'LIQUIDAR_ADEUDO', 'USUARIOS', {
    adeudoId,
    incidenciaId: debt.incidenciaId,
    usuarioId: debt.usuarioId,
    comprobante: evidence,
    notas: notes,
  });
  for (const c of debt.convenios.filter((c) => c.estado !== 'LIQUIDADO'))
    await audit(tx, actor, 'LIQUIDAR_CONVENIO', 'USUARIOS', {
      convenioId: c.id,
      adeudoId,
      comprobante: evidence,
    });
  const estado = await eligibility(tx, debt.usuarioId);
  await notify(
    tx,
    debt.usuarioId,
    'LIQUIDACION',
    `Tu adeudo ${adeudoId} fue liquidado administrativamente. Estado de cuenta: ${estado.estado}.`,
  );
  return {
    mensaje:
      'Liquidación administrativa registrada. Revisa por separado las piezas en mantenimiento o perdidas.',
    estadoCuenta: estado,
  };
}

router.post(
  '/convenios/:id/liquidar',
  asyncHandler(async (req, res) => {
    const convenioId = id(req.params.id);
    const body = req.body || {};
    const comprobante = text(body.comprobante, 'Comprobante o constancia de reposición', {
      max: 2000,
    });
    const notas = text(body.notas, 'Notas', { max: 2000, optional: true });
    const result = await transaction(async (tx) => {
      const convenio = await tx.convenio.findUnique({ where: { id: convenioId } });
      if (!convenio) fail(404, 'El convenio no existe.');
      if (convenio.estado === 'LIQUIDADO') fail(409, 'El convenio ya fue liquidado.');
      return settleDebt(tx, convenio.adeudoId, req.usuario, comprobante, notas);
    });
    res.json(result);
  }),
);

router.post(
  '/adeudos/:id/liquidar',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const comprobante = text(body.comprobante, 'Comprobante o constancia de reposición', {
      max: 2000,
    });
    const notas = text(body.notas, 'Notas', { max: 2000, optional: true });
    res.json(
      await transaction((tx) => settleDebt(tx, id(req.params.id), req.usuario, comprobante, notas)),
    );
  }),
);

router.get(
  '/reportes',
  asyncHandler(async (req, res) => {
    const report = await buildReport(req.query);
    await sendReport(res, report, req.query.formato);
  }),
);

router.get(
  '/actividad',
  asyncHandler(async (req, res) => {
    const where = {};
    if (req.query.modulo) {
      if (!['USUARIOS', 'PRESTAMOS', 'MATERIALES'].includes(req.query.modulo))
        fail(400, 'Selecciona una categoría válida de la bitácora.');
      where.modulo = req.query.modulo;
    }
    const range = dateRange(req.query);
    if (range) where.fecha = range;
    const usuarioId = queryId(req.query.usuarioId);
    if (usuarioId) where.usuarioId = usuarioId;
    res.json(
      await prisma.actividad.findMany({ where, orderBy: [{ fecha: 'desc' }, { id: 'desc' }] }),
    );
  }),
);

router.get(
  '/avisos',
  asyncHandler(async (req, res) =>
    res.json(await prisma.aviso.findMany({ orderBy: { creadoEn: 'desc' } })),
  ),
);
router.post(
  '/avisos',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const data = {
      titulo: text(body.titulo, 'Título', { max: 180 }),
      contenido: text(body.contenido, 'Contenido del aviso', { max: 5000 }),
      activo: body.activo === undefined ? true : boolean(body.activo, 'Activo'),
    };
    const result = await transaction(async (tx) => {
      const aviso = await tx.aviso.create({ data });
      await audit(tx, req.usuario, 'PUBLICAR_AVISO', 'USUARIOS', {
        avisoId: aviso.id,
        titulo: aviso.titulo,
        activo: aviso.activo,
      });
      return aviso;
    });
    res.status(201).json(result);
  }),
);
router.patch(
  '/avisos/:id',
  asyncHandler(async (req, res) => {
    const avisoId = id(req.params.id);
    const body = req.body || {};
    const data = {};
    if (body.titulo !== undefined) data.titulo = text(body.titulo, 'Título', { max: 180 });
    if (body.contenido !== undefined)
      data.contenido = text(body.contenido, 'Contenido del aviso', { max: 5000 });
    if (body.activo !== undefined) data.activo = boolean(body.activo, 'Activo');
    if (!Object.keys(data).length) fail(400, 'No se recibieron cambios para el aviso.');
    const result = await transaction(async (tx) => {
      const aviso = await tx.aviso.update({ where: { id: avisoId }, data });
      await audit(tx, req.usuario, 'MODIFICAR_AVISO', 'USUARIOS', { avisoId, ...data });
      return aviso;
    });
    res.json(result);
  }),
);

async function practiceData(tx, body, partial) {
  const data = {};
  if (!partial || body.nombre !== undefined)
    data.nombre = text(body.nombre, 'Nombre de la práctica', { max: 180 });
  if (!partial || body.descripcion !== undefined)
    data.descripcion = text(body.descripcion ?? '', 'Descripción de la práctica', {
      max: 3000,
      optional: true,
    });
  if (!partial || body.materiales !== undefined) {
    if (!Array.isArray(body.materiales) || !body.materiales.length || body.materiales.length > 100)
      fail(400, 'Agrega entre 1 y 100 materiales a la práctica.');
    data.materiales = body.materiales.map((item) => ({
      materialId: id(item?.materialId, 'material'),
      cantidad: integer(item?.cantidad, 'Cantidad sugerida', 1, 1000),
    }));
    const ids = data.materiales.map((m) => m.materialId);
    if (new Set(ids).size !== ids.length)
      fail(400, 'Un material no puede repetirse en la práctica.');
    if (
      (await tx.material.count({ where: { id: { in: ids }, estado: { not: 'BAJA' } } })) !==
      ids.length
    )
      fail(400, 'La lista incluye materiales inexistentes o dados de baja.');
  }
  return data;
}

router.get(
  '/practicas',
  asyncHandler(async (req, res) =>
    res.json(await prisma.practica.findMany({ orderBy: { nombre: 'asc' } })),
  ),
);
router.post(
  '/practicas',
  asyncHandler(async (req, res) => {
    const result = await transaction(async (tx) => {
      const data = await practiceData(tx, req.body || {}, false);
      const practica = await tx.practica.create({ data });
      await audit(tx, req.usuario, 'CREAR_PRACTICA', 'MATERIALES', {
        practicaId: practica.id,
        nombre: practica.nombre,
        materiales: practica.materiales,
      });
      return practica;
    });
    res.status(201).json(result);
  }),
);
router.patch(
  '/practicas/:id',
  asyncHandler(async (req, res) => {
    const practicaId = id(req.params.id);
    const result = await transaction(async (tx) => {
      const data = await practiceData(tx, req.body || {}, true);
      if (!Object.keys(data).length) fail(400, 'No se recibieron cambios para la práctica.');
      const practica = await tx.practica.update({ where: { id: practicaId }, data });
      await audit(tx, req.usuario, 'MODIFICAR_PRACTICA', 'MATERIALES', { practicaId, ...data });
      return practica;
    });
    res.json(result);
  }),
);

module.exports = router;
