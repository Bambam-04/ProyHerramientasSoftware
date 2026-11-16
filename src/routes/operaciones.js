const express = require('express');
const { randomBytes } = require('node:crypto');
const {
  prisma,
  asyncHandler,
  fail,
  audit,
  notify,
  transaction,
  config,
  eligibility,
  disponible,
  materialView,
  now,
  parseDateTime,
  isWeekend,
  maxReturn,
  validatePickup,
} = require('../lib/core');
const { auth, requireRoles } = require('../lib/auth');

const router = express.Router();
router.use(auth);
const alumno = requireRoles('ALUMNO', 'DOCENTE');
const operativo = requireRoles('ADMIN', 'ENCARGADO');
const CONDICIONES = ['INTEGRO', 'RAYADO', 'ASTILLADO', 'DANADO', 'ROTO', 'PERDIDO'];
const usuarioSelect = {
  id: true,
  nombre: true,
  matricula: true,
  correo: true,
  fotografia: true,
  rol: true,
};
const loanInclude = {
  usuario: { select: usuarioSelect },
  material: true,
  piezas: { include: { pieza: { include: { material: true } } }, orderBy: { id: 'asc' } },
  defectos: { orderBy: { creadoEn: 'asc' } },
  incidencias: { include: { adeudo: { include: { convenios: true } } } },
};

function id(value, label = 'identificador') {
  if (
    !/^[1-9]\d*$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > 2147483647
  )
    fail(400, `El ${label} debe ser un entero positivo válido.`);
  return Number(value);
}

function texto(value, label, max = 2000, obligatorio = true) {
  if (typeof value !== 'string' || value.length > max || (obligatorio && !value.trim()))
    fail(
      400,
      `${label}: proporciona texto ${obligatorio ? 'no vacío ' : ''}de hasta ${max} caracteres.`,
    );
  return value.trim();
}

function cuerpo(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
    fail(400, 'Envía los datos del formulario.');
  return req.body;
}

function condicion(value, perdida = false) {
  const result = value === 'BUENO' ? 'INTEGRO' : value;
  if (!CONDICIONES.includes(result) || (!perdida && result === 'PERDIDO'))
    fail(400, 'Registra una condición física válida para cada pieza.');
  return result;
}

function lecturaPiezas(value, perdida = false) {
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    fail(400, 'Escanea todas las piezas de la solicitud e indica su condición física.');
  const vistos = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      fail(400, 'La lectura de piezas no es válida.');
    const codigo = texto(item.codigo, 'Código de pieza', 100);
    if (vistos.has(codigo)) fail(400, `La pieza ${codigo} se escaneó más de una vez.`);
    vistos.add(codigo);
    return {
      codigo,
      condicion: condicion(item.condicion, perdida),
      notas: texto(item.notas ?? '', 'Observaciones', 2000, false),
    };
  });
}

function validarPiezas(loan, lecturas) {
  const esperadas = new Map(loan.piezas.map((p) => [p.pieza.codigo, p]));
  for (const p of lecturas) {
    if (!esperadas.has(p.codigo))
      fail(
        409,
        `La pieza ${p.codigo} no corresponde a esta solicitud. La operación fue bloqueada.`,
      );
  }
  if (lecturas.length !== esperadas.size)
    fail(400, 'Deben escanearse todas las piezas de la solicitud, una sola vez cada una.');
  return esperadas;
}

// RN-09 / RF-ENC-06.2: en la entrega, cada pieza escaneada debe corresponder a un material
// solicitado. El encargado puede entregar cualquier pieza disponible de ese material, sin
// depender de la pieza reservada al registrar la solicitud ni del orden de lectura; la
// reserva original se reasigna a la pieza física entregada.
async function asignarPiezasEntrega(tx, loan, lecturas) {
  const requeridas = new Map();
  for (const pp of loan.piezas) {
    if (!requeridas.has(pp.pieza.materialId)) requeridas.set(pp.pieza.materialId, []);
    requeridas.get(pp.pieza.materialId).push(pp);
  }
  const propias = new Map(loan.piezas.map((pp) => [pp.piezaId, pp]));
  const encontradas = await tx.pieza.findMany({
    where: { codigo: { in: lecturas.map((l) => l.codigo) } },
    include: { material: true },
  });
  const porCodigo = new Map(encontradas.map((p) => [p.codigo, p]));
  const escaneadas = new Map();
  for (const lectura of lecturas) {
    const pieza = porCodigo.get(lectura.codigo);
    if (!pieza || !requeridas.has(pieza.materialId))
      fail(
        409,
        `La pieza ${lectura.codigo} no corresponde a los materiales de esta solicitud. La entrega fue bloqueada.`,
      );
    if (!propias.has(pieza.id) && pieza.estado !== 'DISPONIBLE')
      fail(
        409,
        `La pieza ${lectura.codigo} no está disponible (está reservada, prestada o fuera de servicio). Escanea otra pieza de ${pieza.material.nombre}.`,
      );
    if (!escaneadas.has(pieza.materialId)) escaneadas.set(pieza.materialId, []);
    escaneadas.get(pieza.materialId).push({ lectura, pieza });
  }
  for (const [materialId, reservadas] of requeridas) {
    const leidas = escaneadas.get(materialId)?.length || 0;
    if (leidas !== reservadas.length)
      fail(
        400,
        `Escanea ${reservadas.length} pieza(s) de ${reservadas[0].pieza.material.nombre}; se leyeron ${leidas}.`,
      );
  }
  const asignaciones = [];
  for (const [materialId, reservadas] of requeridas) {
    const leidas = escaneadas.get(materialId);
    const ids = new Set(leidas.map((x) => x.pieza.id));
    // Registros cuya pieza reservada no se entregó: se reasignan a las piezas sustitutas.
    const sinEntregar = reservadas.filter((pp) => !ids.has(pp.piezaId));
    for (const { lectura, pieza } of leidas) {
      const propia = propias.get(pieza.id);
      asignaciones.push(
        propia
          ? { lectura, pieza, registro: propia, sustituye: false }
          : { lectura, pieza, registro: sinEntregar.shift(), sustituye: true },
      );
    }
  }
  return asignaciones;
}

async function buscarPrestamo(tx, prestamoId, usuarioId) {
  const loan = await tx.prestamo.findUnique({ where: { id: prestamoId }, include: loanInclude });
  if (!loan || (usuarioId !== undefined && loan.usuarioId !== usuarioId))
    fail(404, 'La solicitud no existe.');
  return loan;
}

async function cambiarEstado(tx, loan, esperado, data) {
  if (!(Array.isArray(esperado) ? esperado : [esperado]).includes(loan.estado))
    fail(409, 'La solicitud ya cambió de estado. Actualiza la lista para continuar.');
  const changed = await tx.prestamo.updateMany({
    where: { id: loan.id, estado: loan.estado },
    data,
  });
  if (changed.count !== 1)
    fail(409, 'Otra persona actualizó esta solicitud. Actualiza la lista para continuar.');
}

function materialesDelPrestamo(loan) {
  return [...new Set(loan.piezas.map((p) => p.pieza.materialId))];
}

async function disponibilidadAnterior(tx, materialIds) {
  const result = new Map();
  for (const materialId of materialIds) result.set(materialId, await disponible(tx, materialId));
  return result;
}

// Las suscripciones se notifican solo al pasar de agotado a disponible.
async function avisarDisponibilidad(tx, anteriores) {
  for (const [materialId, anterior] of anteriores) {
    if (anterior > 0 || (await disponible(tx, materialId)) < 1) continue;
    const material = await tx.material.findUnique({ where: { id: materialId } });
    if (!material || material.estado !== 'ACTIVO') continue;
    const intereses = await tx.interes.findMany({
      where: { materialId, usuario: { activo: true } },
    });
    for (const interes of intereses)
      await notify(
        tx,
        interes.usuarioId,
        'DISPONIBILIDAD',
        `${material.nombre} volvió a estar disponible. Consulta el catálogo para solicitarlo.`,
      );
  }
}

async function liberar(tx, loan, actor, estado, mensaje) {
  const anteriores = await disponibilidadAnterior(tx, materialesDelPrestamo(loan));
  await cambiarEstado(tx, loan, ['PENDIENTE', 'PREPARADA'], { estado });
  const piezas = loan.piezas.map((p) => p.piezaId);
  const changed = await tx.pieza.updateMany({
    where: { id: { in: piezas }, estado: 'RESERVADA' },
    data: { estado: 'DISPONIBLE' },
  });
  if (changed.count !== piezas.length)
    fail(409, 'El inventario de la solicitud cambió. Actualiza la lista y vuelve a intentar.');
  await notify(tx, loan.usuarioId, estado, mensaje);
  await audit(tx, actor, estado, 'PRESTAMOS', { prestamoId: loan.id, piezas });
  await avisarDisponibilidad(tx, anteriores);
}

async function conLimite(loan, cfg) {
  if (loan.estado !== 'PREPARADA' || !loan.piezas.length) return loan;
  const horas = Math.min(...loan.piezas.map((p) => p.pieza.material.maxHoras));
  return { ...loan, maxFechaDevolucion: maxReturn(now(), horas, cfg.horaCierre), maxHoras: horas };
}

router.get(
  '/materiales',
  asyncHandler(async (req, res) => {
    const q = texto(req.query.q ?? '', 'Búsqueda', 150, false).toLocaleLowerCase('es');
    const categoria = texto(req.query.categoria ?? '', 'Categoría', 100, false).toLocaleLowerCase(
      'es',
    );
    const materiales = await materialView(prisma);
    res.json(
      materiales.filter(
        (m) =>
          (!q || `${m.nombre} ${m.categoria}`.toLocaleLowerCase('es').includes(q)) &&
          (!categoria || m.categoria.toLocaleLowerCase('es') === categoria),
      ),
    );
  }),
);

router.get(
  '/practicas',
  alumno,
  asyncHandler(async (req, res) => {
    const q = texto(req.query.q ?? '', 'Búsqueda', 150, false);
    res.json(
      await prisma.practica.findMany({
        where: q ? { nombre: { contains: q, mode: 'insensitive' } } : {},
        orderBy: { nombre: 'asc' },
      }),
    );
  }),
);

router.post(
  '/prestamos',
  alumno,
  asyncHandler(async (req, res) => {
    const body = cuerpo(req);
    if (body.aceptaUsoInterno !== true)
      fail(
        400,
        'Confirma que el material se utilizará exclusivamente dentro de las instalaciones de la facultad.',
      );
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50)
      fail(400, 'Selecciona entre uno y 50 materiales para tu solicitud.');
    const vistos = new Set();
    let total = 0;
    const items = body.items
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          fail(400, 'La lista de materiales no es válida.');
        const materialId = id(item.materialId, 'material');
        const cantidad = id(item.cantidad, 'número de piezas');
        if (cantidad > 1000 || (total += cantidad) > 1000)
          fail(400, 'Una solicitud admite un máximo de 1000 piezas.');
        if (vistos.has(materialId))
          fail(400, 'Cada material debe aparecer una sola vez. Ajusta su cantidad en el carrito.');
        vistos.add(materialId);
        return { materialId, cantidad };
      })
      .sort((a, b) => a.materialId - b.materialId);
    const fechaRecoleccion = parseDateTime(body.fechaRecoleccion);
    if (!fechaRecoleccion || Number.isNaN(fechaRecoleccion.getTime()))
      fail(400, 'Selecciona una fecha y hora de recolección válidas.');
    const result = await transaction(async (tx) => {
      const estado = await eligibility(tx, req.usuario.id);
      if (!estado.puedeSolicitar)
        fail(403, estado.motivo || 'Tu cuenta no está habilitada para solicitar material.');
      const cfg = await config(tx);
      await validatePickup(fechaRecoleccion, cfg);
      const piezas = [];
      for (const item of items) {
        const material = await tx.material.findUnique({ where: { id: item.materialId } });
        if (!material || material.estado === 'BAJA')
          fail(404, 'Uno de los materiales ya no está en el catálogo. Actualiza tu solicitud.');
        if (material.estado !== 'ACTIVO') fail(409, `${material.nombre} está fuera de servicio.`);
        const libres = await tx.pieza.findMany({
          where: { materialId: item.materialId, estado: 'DISPONIBLE' },
          orderBy: { id: 'asc' },
          take: item.cantidad,
        });
        if (libres.length < item.cantidad)
          fail(
            409,
            `No hay suficientes unidades de ${material.nombre}. Hay ${libres.length} disponible(s).`,
          );
        const changed = await tx.pieza.updateMany({
          where: { id: { in: libres.map((p) => p.id) }, estado: 'DISPONIBLE' },
          data: { estado: 'RESERVADA' },
        });
        if (changed.count !== item.cantidad)
          fail(409, 'Otra solicitud acaba de reservar ese material. Actualiza el catálogo.');
        piezas.push(...libres);
      }
      const loan = await tx.prestamo.create({
        data: {
          usuarioId: req.usuario.id,
          materialId: items.length === 1 ? items[0].materialId : null,
          cantidad: total,
          fechaRecoleccion,
          estado: 'PENDIENTE',
          piezas: { create: piezas.map((p) => ({ piezaId: p.id })) },
        },
      });
      await audit(tx, req.usuario, 'SOLICITAR', 'PRESTAMOS', {
        prestamoId: loan.id,
        items,
        fechaRecoleccion: fechaRecoleccion.toISOString(),
        aceptaUsoInterno: true,
      });
      return loan;
    });
    res.status(201).json({
      mensaje:
        'Solicitud registrada. El material quedó reservado y tu solicitud entró a la cola de ventanilla.',
      id: result.id,
      estado: result.estado,
    });
  }),
);

router.get(
  '/mis-prestamos',
  alumno,
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.prestamo.findMany({
        where: { usuarioId: req.usuario.id },
        include: loanInclude,
        orderBy: [{ fechaSolicitud: 'desc' }, { id: 'desc' }],
      }),
    );
  }),
);

router.post(
  '/prestamos/:id/cancelar',
  alumno,
  asyncHandler(async (req, res) => {
    const prestamoId = id(req.params.id);
    await transaction(async (tx) => {
      const loan = await buscarPrestamo(tx, prestamoId, req.usuario.id);
      if (loan.estado !== 'PENDIENTE')
        fail(
          409,
          'Solo puedes cancelar solicitudes pendientes. El material ya está en preparación o el préstamo avanzó.',
        );
      await liberar(
        tx,
        loan,
        req.usuario,
        'CANCELADO',
        'Cancelaste tu solicitud. El material reservado volvió al inventario disponible.',
      );
    });
    res.json({ mensaje: 'Solicitud cancelada y material liberado.' });
  }),
);

router.post(
  '/prestamos/:id/defectos',
  alumno,
  asyncHandler(async (req, res) => {
    const prestamoId = id(req.params.id);
    const body = cuerpo(req);
    const prestamoPiezaId = id(body.prestamoPiezaId, 'registro de pieza');
    const descripcion = texto(body.descripcion, 'Describe el defecto previo');
    const estadoFisico = condicion(body.condicion);
    if (estadoFisico === 'INTEGRO')
      fail(400, 'Selecciona la condición correspondiente al defecto que reportas.');
    const result = await transaction(async (tx) => {
      const loan = await buscarPrestamo(tx, prestamoId, req.usuario.id);
      if (loan.estado !== 'ENTREGADO')
        fail(
          409,
          'Solo puedes reportar defectos del material recibido mientras el préstamo esté activo.',
        );
      const pieza = loan.piezas.find((p) => p.id === prestamoPiezaId && !p.devuelta);
      if (!pieza) fail(400, 'La pieza no forma parte de tu préstamo activo.');
      if (
        loan.defectos.some(
          (d) =>
            d.prestamoPiezaId === prestamoPiezaId &&
            (d.estado === 'PENDIENTE' || (d.estado === 'ACEPTADO' && d.condicion === estadoFisico)),
        )
      )
        fail(409, 'Esta pieza ya tiene un reporte pendiente o aceptado para ese defecto.');
      const defecto = await tx.defectoPrevio.create({
        data: { prestamoId, prestamoPiezaId, descripcion, condicion: estadoFisico },
      });
      await audit(tx, req.usuario, 'REPORTAR_DEFECTO_PREVIO', 'PRESTAMOS', {
        prestamoId,
        defectoId: defecto.id,
        prestamoPiezaId,
      });
      return defecto;
    });
    res
      .status(201)
      .json({ mensaje: 'Reporte enviado al encargado para su validación.', defecto: result });
  }),
);

router.post(
  '/materiales/:id/interes',
  alumno,
  asyncHandler(async (req, res) => {
    const materialId = id(req.params.id, 'material');
    const material = await prisma.material.findUnique({ where: { id: materialId } });
    if (!material || material.estado === 'BAJA') fail(404, 'El material no existe en el catálogo.');
    await prisma.interes.upsert({
      where: { usuarioId_materialId: { usuarioId: req.usuario.id, materialId } },
      create: { usuarioId: req.usuario.id, materialId },
      update: {},
    });
    res
      .status(201)
      .json({ mensaje: 'Te notificaremos cuando este material vuelva a estar disponible.' });
  }),
);

router.get(
  '/operacion/prestamos',
  operativo,
  asyncHandler(async (req, res) => {
    const cfg = await config();
    const loans = await prisma.prestamo.findMany({
      include: loanInclude,
      orderBy: [{ fechaSolicitud: 'asc' }, { id: 'asc' }],
    });
    res.json(await Promise.all(loans.map((loan) => conLimite(loan, cfg))));
  }),
);

router.get(
  '/operacion/prestamos/codigo/:codigo',
  operativo,
  asyncHandler(async (req, res) => {
    const codigo = texto(req.params.codigo, 'Código de solicitud', 100);
    const loan = await prisma.prestamo.findUnique({ where: { codigo }, include: loanInclude });
    if (!loan)
      fail(404, 'El código no corresponde a una solicitud. Verifica el código presentado.');
    res.json(await conLimite(loan, await config()));
  }),
);

// Identifica una pieza escaneada para validar cada lectura en ventanilla al momento.
router.get(
  '/operacion/piezas/codigo/:codigo',
  operativo,
  asyncHandler(async (req, res) => {
    const codigo = texto(req.params.codigo, 'Código de pieza', 100);
    const pieza = await prisma.pieza.findUnique({
      where: { codigo },
      select: {
        codigo: true,
        estado: true,
        condicion: true,
        materialId: true,
        material: { select: { nombre: true, estado: true } },
      },
    });
    if (!pieza) fail(404, `La pieza ${codigo} no está registrada en el inventario.`);
    res.json(pieza);
  }),
);

router.post(
  '/operacion/prestamos/:id/preparar',
  operativo,
  asyncHandler(async (req, res) => {
    const prestamoId = id(req.params.id);
    const result = await transaction(async (tx) => {
      const loan = await buscarPrestamo(tx, prestamoId);
      if (loan.estado !== 'PENDIENTE') fail(409, 'Solo se pueden preparar solicitudes pendientes.');
      const cfg = await config(tx);
      const instante = now();
      // Las pendientes cuya recolección y tolerancia ya vencieron no bloquean la cola FIFO;
      // la revisión automática las cancela y libera su material.
      const primera = await tx.prestamo.findFirst({
        where: {
          estado: 'PENDIENTE',
          OR: [
            { fechaRecoleccion: null },
            {
              fechaRecoleccion: {
                gte: new Date(instante.getTime() - cfg.toleranciaMinutos * 60000),
              },
            },
          ],
        },
        orderBy: [{ fechaSolicitud: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (
        loan.fechaRecoleccion &&
        loan.fechaRecoleccion.getTime() + cfg.toleranciaMinutos * 60000 <= instante.getTime()
      )
        fail(
          409,
          'La hora de recolección y su tolerancia ya vencieron. La solicitud se cancelará automáticamente y su material quedará libre.',
        );
      if (!primera || primera.id !== loan.id)
        fail(409, 'Atiende primero la solicitud pendiente más antigua de la cola.');
      if (
        !loan.piezas.length ||
        loan.piezas.some(
          (p) => p.pieza.estado !== 'RESERVADA' || p.pieza.material.estado !== 'ACTIVO',
        )
      )
        fail(
          409,
          'El material reservado no está listo para entregarse. Revisa la solicitud antes de prepararla.',
        );
      if (!loan.fechaRecoleccion)
        fail(409, 'La solicitud no tiene una hora de recolección válida.');
      const limiteRecogida = new Date(
        loan.fechaRecoleccion.getTime() + cfg.toleranciaMinutos * 60000,
      );
      const codigo = `CIMA-${randomBytes(12).toString('hex').toUpperCase()}`;
      await cambiarEstado(tx, loan, 'PENDIENTE', {
        estado: 'PREPARADA',
        fechaPreparacion: instante,
        limiteRecogida,
        codigo,
      });
      await notify(
        tx,
        loan.usuarioId,
        'PREPARADA',
        `Tu solicitud está preparada. Presenta el código ${codigo} y tu identificación en ventanilla. Recógela en el horario acordado, antes de ${limiteRecogida.toISOString()}.`,
        `preparada-${loan.id}`,
      );
      await audit(tx, req.usuario, 'PREPARAR', 'PRESTAMOS', {
        prestamoId: loan.id,
        limiteRecogida: limiteRecogida.toISOString(),
      });
      return { codigo, limiteRecogida };
    });
    res.json({
      mensaje: 'Solicitud preparada. Se notificó al alumno y comenzó el control de tolerancia.',
      ...result,
    });
  }),
);

router.post(
  '/operacion/prestamos/:id/no-recogido',
  operativo,
  asyncHandler(async (req, res) => {
    const prestamoId = id(req.params.id);
    await transaction(async (tx) => {
      const loan = await buscarPrestamo(tx, prestamoId);
      if (loan.estado !== 'PREPARADA')
        fail(409, 'Solo se pueden liberar por inasistencia las solicitudes preparadas.');
      if (!loan.limiteRecogida || now() < loan.limiteRecogida)
        fail(409, 'El tiempo de tolerancia todavía no vence.');
      await liberar(
        tx,
        loan,
        req.usuario,
        'NO_RECOGIDO',
        'Tu solicitud se canceló por inasistencia al vencer la tolerancia. El material volvió al inventario.',
      );
    });
    res.json({
      mensaje:
        'Solicitud marcada como no recogida. El material fue liberado y el alumno recibió una notificación.',
    });
  }),
);

router.post(
  '/operacion/prestamos/:id/rechazar',
  operativo,
  asyncHandler(async (req, res) => {
    const prestamoId = id(req.params.id);
    const motivo = texto(req.body?.motivo ?? '', 'Motivo del rechazo', 2000, false);
    await transaction(async (tx) => {
      const loan = await buscarPrestamo(tx, prestamoId);
      if (!['PENDIENTE', 'PREPARADA'].includes(loan.estado))
        fail(409, 'Solo se pueden rechazar solicitudes pendientes o preparadas.');
      await liberar(
        tx,
        loan,
        req.usuario,
        'RECHAZADO',
        `Tu solicitud fue rechazada por ventanilla.${motivo ? ` Motivo: ${motivo}` : ' Consulta al encargado para más información.'}`,
      );
    });
    res.json({ mensaje: 'Solicitud rechazada y material reservado liberado.' });
  }),
);

router.post(
  '/operacion/prestamos/:id/entregar',
  operativo,
  asyncHandler(async (req, res) => {
    const prestamoId = id(req.params.id);
    const body = cuerpo(req);
    const codigo = texto(body.codigo, 'Código de solicitud', 100);
    if (body.identidadVerificada !== true)
      fail(
        400,
        'Confirma la identidad del alumno con sus datos de identificación antes de entregar.',
      );
    const fechaDevolucion = parseDateTime(body.fechaDevolucion);
    if (!fechaDevolucion || Number.isNaN(fechaDevolucion.getTime()))
      fail(400, 'Selecciona una fecha y hora de devolución válidas.');
    const lecturas = lecturaPiezas(body.piezas);
    if (lecturas.some((p) => ['DANADO', 'ROTO'].includes(p.condicion)))
      fail(
        409,
        'No se puede entregar material dañado o roto. Rechaza la solicitud e informa al administrador para revisar el inventario.',
      );
    await transaction(async (tx) => {
      const loan = await buscarPrestamo(tx, prestamoId);
      if (loan.estado !== 'PREPARADA')
        fail(409, 'La solicitud debe estar preparada antes de registrar la entrega.');
      if (loan.codigo !== codigo)
        fail(
          409,
          'El código presentado no corresponde a esta solicitud. La entrega fue bloqueada.',
        );
      const instante = now();
      if (!loan.limiteRecogida || instante >= loan.limiteRecogida)
        fail(
          409,
          'Venció la tolerancia de recolección. El material debe liberarse por inasistencia.',
        );
      if (isWeekend(instante)) fail(400, 'No se permite recoger material en sábado o domingo.');
      const cuenta = await eligibility(tx, loan.usuarioId);
      if (!cuenta.puedeSolicitar)
        fail(403, cuenta.motivo || 'La cuenta del alumno está restringida para nuevos préstamos.');
      if (
        loan.piezas.some(
          (p) => p.pieza.estado !== 'RESERVADA' || p.pieza.material.estado !== 'ACTIVO',
        )
      )
        fail(409, 'Hay piezas reservadas fuera de servicio. No se puede registrar la entrega.');
      const asignaciones = await asignarPiezasEntrega(tx, loan, lecturas);
      const cfg = await config(tx);
      const maxHoras = Math.min(...loan.piezas.map((p) => p.pieza.material.maxHoras));
      const limite = maxReturn(instante, maxHoras, cfg.horaCierre);
      if (fechaDevolucion <= instante || fechaDevolucion > limite || isWeekend(fechaDevolucion))
        fail(
          400,
          `La devolución debe ser posterior a la entrega, en día hábil y antes del límite ${limite.toISOString()}.`,
        );
      await cambiarEstado(tx, loan, 'PREPARADA', {
        estado: 'ENTREGADO',
        fechaEntrega: instante,
        fechaDevolucion,
        identidadVerificada: true,
        encargadoEntregaId: req.usuario.id,
        condicionEntrega: lecturas.every((p) => p.condicion === 'INTEGRO') ? 'INTEGRO' : null,
      });
      const sustituciones = [];
      for (const { lectura, pieza, registro, sustituye } of asignaciones) {
        if (sustituye) {
          const liberada = await tx.pieza.updateMany({
            where: { id: registro.piezaId, estado: 'RESERVADA' },
            data: { estado: 'DISPONIBLE' },
          });
          if (liberada.count !== 1)
            fail(409, 'Una pieza cambió de estado. Actualiza la solicitud antes de continuar.');
          sustituciones.push({ reservada: registro.pieza.codigo, entregada: pieza.codigo });
        }
        const changed = await tx.pieza.updateMany({
          where: { id: pieza.id, estado: sustituye ? 'DISPONIBLE' : 'RESERVADA' },
          data: { estado: 'PRESTADA', condicion: lectura.condicion },
        });
        if (changed.count !== 1)
          fail(409, 'Una pieza cambió de estado. Actualiza la solicitud antes de continuar.');
        await tx.prestamoPieza.update({
          where: { id: registro.id },
          data: {
            piezaId: pieza.id,
            condicionEntrega: lectura.condicion,
            notasEntrega: lectura.notas,
          },
        });
      }
      await notify(
        tx,
        loan.usuarioId,
        'ENTREGADO',
        `Recibiste el material de tu solicitud. Debes devolverlo antes de ${fechaDevolucion.toISOString()}. Recuerda que su uso está limitado a las instalaciones de la facultad.`,
        `entregado-${loan.id}`,
      );
      await audit(tx, req.usuario, 'ENTREGAR', 'PRESTAMOS', {
        prestamoId: loan.id,
        identidadVerificada: true,
        fechaDevolucion: fechaDevolucion.toISOString(),
        piezas: lecturas,
        sustituciones,
      });
    });
    res.json({
      mensaje: 'Identidad y piezas verificadas. Entrega registrada; el préstamo está activo.',
    });
  }),
);

router.post(
  '/operacion/prestamos/:id/devolver',
  operativo,
  asyncHandler(async (req, res) => {
    const prestamoId = id(req.params.id);
    const body = cuerpo(req);
    const lecturas = lecturaPiezas(body.piezas, true);
    const result = await transaction(async (tx) => {
      const loan = await buscarPrestamo(tx, prestamoId);
      if (loan.estado !== 'ENTREGADO')
        fail(409, 'Solo pueden devolverse préstamos entregados que todavía estén activos.');
      const esperadas = validarPiezas(loan, lecturas);
      if (loan.defectos.some((d) => d.estado === 'PENDIENTE'))
        fail(409, 'Resuelve primero los reportes de defecto previo de este préstamo.');
      const nuevasIncidencias = lecturas.filter((lectura) => {
        if (lectura.condicion === 'INTEGRO') return false;
        const pieza = esperadas.get(lectura.codigo);
        const entregada = pieza.condicionEntrega === 'BUENO' ? 'INTEGRO' : pieza.condicionEntrega;
        const defectoAceptado = loan.defectos.some(
          (d) =>
            d.prestamoPiezaId === pieza.id &&
            d.estado === 'ACEPTADO' &&
            d.condicion === lectura.condicion,
        );
        return (
          lectura.condicion === 'PERDIDO' || (lectura.condicion !== entregada && !defectoAceptado)
        );
      });
      if (nuevasIncidencias.length && body.confirmarIncidencias !== true)
        fail(
          400,
          'Confirma la generación de incidencias y adeudos por el material dañado, perdido o con defectos nuevos.',
        );
      if (loan.piezas.some((p) => p.devuelta || p.pieza.estado !== 'PRESTADA'))
        fail(
          409,
          'El estado de las piezas cambió. Actualiza el préstamo antes de registrar su devolución.',
        );
      const anteriores = await disponibilidadAnterior(tx, materialesDelPrestamo(loan));
      const instante = now();
      const incidencias = [];
      const conIncidencia = new Set(nuevasIncidencias.map((p) => p.codigo));
      await cambiarEstado(tx, loan, 'ENTREGADO', {
        estado: nuevasIncidencias.length ? 'INCIDENCIA' : 'DEVUELTO',
        fechaDevuelto: instante,
        encargadoDevolucionId: req.usuario.id,
        condicionDevuelto: lecturas.every((p) => p.condicion === 'INTEGRO') ? 'INTEGRO' : null,
      });
      for (const lectura of lecturas) {
        const pieza = esperadas.get(lectura.codigo);
        await tx.prestamoPieza.update({
          where: { id: pieza.id },
          data: {
            devuelta: true,
            condicionDevuelto: lectura.condicion,
            notasDevuelto: lectura.notas,
          },
        });
        const estadoPieza =
          lectura.condicion === 'PERDIDO'
            ? 'PERDIDA'
            : lectura.condicion === 'INTEGRO'
              ? 'DISPONIBLE'
              : 'MANTENIMIENTO';
        const changed = await tx.pieza.updateMany({
          where: { id: pieza.piezaId, estado: 'PRESTADA' },
          data: { estado: estadoPieza, condicion: lectura.condicion },
        });
        if (changed.count !== 1)
          fail(409, 'Una pieza cambió de estado. Actualiza el préstamo antes de continuar.');
        if (conIncidencia.has(lectura.codigo)) {
          const incidencia = await tx.incidencia.create({
            data: {
              prestamoId: loan.id,
              prestamoPiezaId: pieza.id,
              usuarioId: loan.usuarioId,
              encargadoId: req.usuario.id,
              tipo: lectura.condicion === 'PERDIDO' ? 'PERDIDA' : lectura.condicion,
              descripcion:
                lectura.notas ||
                `La pieza ${lectura.codigo} se registró como ${lectura.condicion.toLowerCase()} durante la devolución.`,
            },
          });
          await tx.adeudo.create({
            data: { incidenciaId: incidencia.id, usuarioId: loan.usuarioId },
          });
          incidencias.push(incidencia);
          await audit(tx, req.usuario, 'GENERAR_INCIDENCIA_ADEUDO', 'PRESTAMOS', {
            prestamoId: loan.id,
            incidenciaId: incidencia.id,
            codigo: lectura.codigo,
            condicion: lectura.condicion,
          });
        }
      }
      for (const materialId of materialesDelPrestamo(loan)) {
        const cantidadTotal = await tx.pieza.count({
          where: { materialId, estado: { notIn: ['BAJA', 'PERDIDA'] } },
        });
        await tx.material.update({ where: { id: materialId }, data: { cantidadTotal } });
      }
      await notify(
        tx,
        loan.usuarioId,
        incidencias.length ? 'INCIDENCIA' : 'DEVUELTO',
        incidencias.length
          ? 'La devolución generó una incidencia y un adeudo por material afectado. Acude con el administrador para formalizar un convenio de reposición. Puedes consultar el comprobante en tu historial.'
          : 'Tu devolución quedó registrada. Gracias por devolver el material.',
      );
      await audit(tx, req.usuario, 'DEVOLVER', 'PRESTAMOS', {
        prestamoId: loan.id,
        estado: incidencias.length ? 'INCIDENCIA' : 'DEVUELTO',
        piezas: lecturas,
        incidencias: incidencias.map((i) => i.id),
      });
      await avisarDisponibilidad(tx, anteriores);
      return { estado: incidencias.length ? 'INCIDENCIA' : 'DEVUELTO', incidencias };
    });
    res.json({
      mensaje: result.incidencias.length
        ? 'Devolución registrada con incidencia y adeudo. El alumno debe acudir con el administrador.'
        : 'Devolución registrada sin adeudos nuevos.',
      ...result,
    });
  }),
);

router.post(
  '/operacion/defectos/:id/resolver',
  operativo,
  asyncHandler(async (req, res) => {
    const defectoId = id(req.params.id);
    const body = cuerpo(req);
    if (typeof body.aceptado !== 'boolean')
      fail(400, 'Indica si el reporte de defecto previo fue aceptado o rechazado.');
    const respuesta = texto(body.respuesta ?? '', 'Respuesta del encargado', 2000, !body.aceptado);
    const result = await transaction(async (tx) => {
      const defecto = await tx.defectoPrevio.findUnique({
        where: { id: defectoId },
        include: { prestamo: { select: { id: true, usuarioId: true, estado: true } } },
      });
      if (!defecto) fail(404, 'El reporte no existe.');
      if (defecto.estado !== 'PENDIENTE' || defecto.prestamo.estado !== 'ENTREGADO')
        fail(409, 'El reporte ya fue resuelto o el préstamo ya no está activo.');
      const estado = body.aceptado ? 'ACEPTADO' : 'RECHAZADO';
      const changed = await tx.defectoPrevio.updateMany({
        where: { id: defectoId, estado: 'PENDIENTE' },
        data: { estado, respuesta, encargadoId: req.usuario.id, resueltoEn: now() },
      });
      if (changed.count !== 1) fail(409, 'Otra persona ya resolvió este reporte.');
      await notify(
        tx,
        defecto.prestamo.usuarioId,
        'DEFECTO_PREVIO',
        `El encargado ${body.aceptado ? 'aceptó' : 'rechazó'} tu reporte de defecto previo.${respuesta ? ` ${respuesta}` : ''}`,
      );
      await audit(tx, req.usuario, 'RESOLVER_DEFECTO_PREVIO', 'PRESTAMOS', {
        defectoId,
        prestamoId: defecto.prestamoId,
        estado,
        respuesta,
      });
      return estado;
    });
    res.json({
      mensaje:
        result === 'ACEPTADO'
          ? 'Defecto aceptado y anexado al historial. Se considerará al registrar la devolución.'
          : 'Reporte rechazado y respuesta notificada al alumno.',
      estado: result,
    });
  }),
);

router.get(
  '/notificaciones',
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.notificacion.findMany({
        where: { usuarioId: req.usuario.id },
        orderBy: [{ creadoEn: 'desc' }, { id: 'desc' }],
        take: 200,
      }),
    );
  }),
);

router.post(
  '/notificaciones/:id/leer',
  asyncHandler(async (req, res) => {
    const notificacionId = id(req.params.id);
    const changed = await prisma.notificacion.updateMany({
      where: { id: notificacionId, usuarioId: req.usuario.id },
      data: { leida: true },
    });
    if (changed.count !== 1) fail(404, 'La notificación no existe.');
    res.json({ mensaje: 'Notificación marcada como leída.' });
  }),
);

router.get(
  '/avisos',
  alumno,
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.aviso.findMany({
        where: { activo: true },
        orderBy: [{ creadoEn: 'desc' }, { id: 'desc' }],
      }),
    );
  }),
);

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

router.get(
  '/incidencias/:id/comprobante',
  asyncHandler(async (req, res) => {
    const incidenciaId = id(req.params.id);
    const incidencia = await prisma.incidencia.findUnique({
      where: { id: incidenciaId },
      include: {
        usuario: { select: usuarioSelect },
        prestamo: true,
        piezaPrestamo: { include: { pieza: { include: { material: true } } } },
        adeudo: { include: { convenios: { orderBy: { fechaCreacion: 'desc' } } } },
      },
    });
    if (
      !incidencia ||
      (!['ADMIN', 'ENCARGADO'].includes(req.usuario.rol) && incidencia.usuarioId !== req.usuario.id)
    )
      fail(404, 'El comprobante no existe.');
    const pieza = incidencia.piezaPrestamo.pieza;
    const fecha = (value) =>
      value
        ? new Date(value).toLocaleString('es-MX', {
            timeZone: process.env.CIMA_TIMEZONE || 'America/Tijuana',
          })
        : 'Sin registrar';
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    });
    res.send(
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CIMA · Comprobante de incidencia ${incidencia.id}</title><style>body{font:16px system-ui,sans-serif;color:#172c27;max-width:800px;margin:40px auto;padding:24px}h1{font-size:24px}dl{display:grid;grid-template-columns:190px 1fr;gap:10px}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}p{white-space:pre-wrap}.firmas{display:flex;justify-content:space-around;margin-top:85px}.firmas span{border-top:1px solid;padding:8px 25px}.ayuda{color:#52665e}@media print{body{margin:0}.ayuda{display:none}}</style></head><body><h1>CIMA · Vale de incidencia #${incidencia.id}</h1><p>Facultad de Ciencias Químicas e Ingeniería</p><dl><dt>Solicitud</dt><dd>#${incidencia.prestamoId}</dd><dt>Alumno</dt><dd>${esc(incidencia.usuario.nombre)}</dd><dt>Matrícula</dt><dd>${esc(incidencia.usuario.matricula)}</dd><dt>Correo institucional</dt><dd>${esc(incidencia.usuario.correo)}</dd><dt>Material</dt><dd>${esc(pieza.material.nombre)}</dd><dt>Código de pieza</dt><dd>${esc(pieza.codigo)}</dd><dt>Fecha de registro</dt><dd>${esc(fecha(incidencia.creadoEn))}</dd><dt>Tipo de incidencia</dt><dd>${esc(incidencia.tipo)}</dd><dt>Estado de incidencia</dt><dd>${esc(incidencia.estado)}</dd><dt>Estado del adeudo</dt><dd>${esc(incidencia.adeudo?.estado || 'Sin adeudo')}</dd><dt>Encargado de registro</dt><dd>#${esc(incidencia.encargadoId)}</dd></dl><h2>Descripción</h2><p>${esc(incidencia.descripcion)}</p><p>Acude con el administrador de almacén para formalizar la reposición del material. Este documento no representa un pago ni un recibo de pago.</p><div class="firmas"><span>Alumno</span><span>Encargado de ventanilla</span></div><p class="ayuda">Utiliza la opción Imprimir de tu navegador para conservar este comprobante.</p></body></html>`,
    );
  }),
);

module.exports = router;
