require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const ZONE = process.env.CIMA_TIMEZONE || 'America/Tijuana';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
function fail(status, mensaje) {
  const error = new Error(mensaje);
  error.status = status;
  throw error;
}
const now = () => new Date();
function localParts(date) {
  const p = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, x.value]),
  );
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
    weekday: new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay(),
  };
}
function isWeekend(date) {
  return [0, 6].includes(localParts(date).weekday);
}
function parseDateTime(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    fail(400, 'Indica una fecha y hora válidas con zona horaria.');
  const date = new Date(value);
  const datePart = value.slice(0, 10);
  const check = new Date(`${datePart}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    !Number.isFinite(check.getTime()) ||
    check.toISOString().slice(0, 10) !== datePart ||
    +value.slice(11, 13) > 23 ||
    +value.slice(14, 16) > 59
  )
    fail(400, 'La fecha y hora no son válidas.');
  return date;
}
function zonedDate(year, month, day, hour, minute) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let result = new Date(target);
  // Iteración de offset para conservar el horario institucional incluso durante DST.
  for (let n = 0; n < 3; n++) {
    const p = localParts(result);
    result = new Date(
      result.getTime() + target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second),
    );
  }
  return result;
}
function maxReturn(start, hours, horaCierre = '20:00') {
  let end = new Date(start.getTime() + hours * 3600000);
  if (isWeekend(end)) {
    const p = localParts(end);
    const friday = new Date(Date.UTC(p.year, p.month - 1, p.day - (p.weekday === 6 ? 1 : 2)));
    const [h, m] = horaCierre.split(':').map(Number);
    end = zonedDate(friday.getUTCFullYear(), friday.getUTCMonth() + 1, friday.getUTCDate(), h, m);
    const max = new Date(start.getTime() + hours * 3600000);
    if (end > max) end = max;
  }
  return end;
}
async function config(tx = prisma) {
  return (
    (await tx.configuracion.findUnique({ where: { id: 1 } })) || {
      id: 1,
      toleranciaMinutos: 15,
      anticipacionMaxHoras: 168,
      anticipacionMinMinutos: 0,
      horaApertura: '07:00',
      horaCierre: '20:00',
      avisoVencimientoMinutos: 60,
    }
  );
}
function validatePickup(date, cfg) {
  const delta = date.getTime() - Date.now();
  if (isWeekend(date)) fail(400, 'La recolección sólo está permitida de lunes a viernes.');
  if (delta < cfg.anticipacionMinMinutos * 60000 - 1000)
    fail(400, 'La hora de recolección debe ser futura y respetar la anticipación mínima.');
  if (delta > cfg.anticipacionMaxHoras * 3600000)
    fail(400, 'La fecha de recolección excede la anticipación permitida.');
  const p = localParts(date),
    h = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  if (h < cfg.horaApertura || h > cfg.horaCierre)
    fail(400, `El horario de recolección es de ${cfg.horaApertura} a ${cfg.horaCierre}.`);
}
async function transaction(fn) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: 'Serializable',
        maxWait: 10000,
        timeout: 120000,
      });
    } catch (error) {
      if (error.code !== 'P2034' || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1) + Math.random() * 30));
    }
  }
}
async function audit(tx, usuario, accion, modulo, detalle) {
  return tx.actividad.create({
    data: {
      usuarioId: usuario?.id || null,
      nombre: usuario?.nombre || 'Sistema',
      rol: usuario?.rol || 'SISTEMA',
      accion,
      modulo,
      ...(detalle === undefined ? {} : { detalle: JSON.parse(JSON.stringify(detalle)) }),
    },
  });
}
async function notify(tx, usuarioId, tipo, mensaje, clave) {
  const data = { usuarioId, tipo, mensaje, ...(clave ? { clave } : {}) };
  return clave
    ? tx.notificacion.upsert({ where: { clave }, create: data, update: {} })
    : tx.notificacion.create({ data });
}
async function eligibility(tx, usuarioId) {
  const u = await tx.usuario.findUnique({ where: { id: usuarioId } });
  if (!u)
    return { estado: 'INACTIVO', puedeSolicitar: false, motivo: 'La cuenta no está disponible.' };
  const padron = ['ALUMNO', 'DOCENTE'].includes(u.rol)
    ? await tx.padron.findFirst({
        where: { matricula: { equals: u.matricula, mode: 'insensitive' } },
      })
    : null;
  if (!u.activo || (['ALUMNO', 'DOCENTE'].includes(u.rol) && (!padron || !padron.activo)))
    return {
      estado: 'INACTIVO',
      puedeSolicitar: false,
      motivo: 'La cuenta está inactiva en el padrón del periodo.',
    };
  if (u.bloqueo)
    return {
      estado: 'BLOQUEADO',
      puedeSolicitar: false,
      motivo: 'La cuenta tiene un bloqueo administrativo. Acude con el administrador.',
    };
  if (!['ALUMNO', 'DOCENTE'].includes(u.rol))
    return {
      estado: 'ACTIVO',
      puedeSolicitar: false,
      motivo: 'Sólo los alumnos pueden solicitar material.',
    };
  const adeudos = await tx.adeudo.findMany({
    where: { usuarioId, estado: { not: 'LIQUIDADO' } },
    include: { convenios: true },
  });
  let pendiente = false;
  for (const a of adeudos) {
    const vigente = a.convenios.some((c) => c.estado === 'ACTIVO' && c.fechaLimite >= now());
    const vencido =
      a.estado === 'VENCIDO' ||
      a.convenios.some(
        (c) => c.estado === 'VENCIDO' || (c.estado === 'ACTIVO' && c.fechaLimite < now()),
      );
    if (vencido && !vigente)
      return {
        estado: 'CON_ADEUDO_VENCIDO',
        puedeSolicitar: false,
        motivo: 'Tienes un adeudo vencido. Acude con el administrador para regularizarlo.',
      };
    if (!vigente) pendiente = true;
  }
  const atrasado = await tx.prestamo.count({
    where: { usuarioId, estado: 'ENTREGADO', fechaDevolucion: { lt: now() } },
  });
  if (atrasado)
    return {
      estado: 'CON_ADEUDO_VENCIDO',
      puedeSolicitar: false,
      motivo:
        'Tienes material con devolución vencida. Devuélvelo antes de solicitar otro préstamo.',
    };
  if (pendiente)
    return {
      estado: 'CON_INCIDENCIA_PENDIENTE',
      puedeSolicitar: false,
      motivo:
        'Tienes una incidencia pendiente. Acude con el administrador para formalizar un convenio.',
    };
  return {
    estado: adeudos.length ? 'CONVENIO_ACTIVO' : 'ACTIVO',
    puedeSolicitar: true,
    motivo: adeudos.length ? 'Puedes solicitar mientras tu convenio permanezca vigente.' : '',
  };
}
async function disponible(tx, materialId) {
  return tx.pieza.count({
    where: { materialId, estado: 'DISPONIBLE', material: { estado: 'ACTIVO' } },
  });
}
async function materialView(tx = prisma) {
  const mats = await tx.material.findMany({
    where: { estado: { not: 'BAJA' } },
    orderBy: { nombre: 'asc' },
    include: { piezas: { select: { estado: true } } },
  });
  return mats.map(({ piezas, ...m }) => {
    const disponibles =
      m.estado === 'ACTIVO' ? piezas.filter((p) => p.estado === 'DISPONIBLE').length : 0;
    const total = piezas.filter((p) => !['BAJA', 'PERDIDA'].includes(p.estado)).length;
    const fuera =
      m.estado === 'MANTENIMIENTO' ||
      (!disponibles &&
        total > 0 &&
        piezas.every((p) => ['BAJA', 'PERDIDA', 'MANTENIMIENTO'].includes(p.estado)));
    return {
      ...m,
      cantidadTotal: total,
      disponibles,
      estadoInventario: m.estado,
      estado: fuera ? 'Fuera de servicio' : disponibles ? 'Disponible' : 'Agotado',
    };
  });
}
async function notifyAvailability(tx, materialId) {
  if (!(await disponible(tx, materialId))) return;
  const material = await tx.material.findUnique({ where: { id: materialId } });
  const interests = await tx.interes.findMany({
    where: { materialId, usuario: { activo: true } },
    include: { usuario: { select: { id: true } } },
  });
  for (const item of interests)
    await notify(
      tx,
      item.usuarioId,
      'DISPONIBILIDAD',
      `${material.nombre} vuelve a estar disponible en el catálogo.`,
    );
  await tx.interes.deleteMany({ where: { id: { in: interests.map((i) => i.id) } } });
}
module.exports = {
  prisma,
  ZONE,
  asyncHandler,
  fail,
  now,
  localParts,
  isWeekend,
  parseDateTime,
  zonedDate,
  maxReturn,
  config,
  validatePickup,
  transaction,
  audit,
  notify,
  eligibility,
  disponible,
  materialView,
  notifyAvailability,
};
