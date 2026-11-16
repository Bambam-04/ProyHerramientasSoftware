const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { prisma, fail, parseDateTime, zonedDate } = require('./core');
const { safeCell } = require('./imports');

const USER = { id: true, nombre: true, matricula: true, correo: true };
const INC_INCLUDE = {
  usuario: { select: USER },
  piezaPrestamo: { include: { pieza: { include: { material: true } } } },
  adeudo: { include: { convenios: true } },
};
function queryId(value) {
  if (value === undefined || value === '') return undefined;
  if (!/^[1-9]\d*$/.test(String(value)) || Number(value) > 2147483647)
    fail(400, 'Los filtros de material y alumno deben ser identificadores válidos.');
  return Number(value);
}
function dateRange(query) {
  const range = {};
  for (const [key, side] of [
    ['desde', 'gte'],
    ['hasta', 'lte'],
  ]) {
    const value = query[key];
    if (!value) continue;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))
      fail(400, 'Usa fechas válidas en los filtros del reporte.');
    const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    let date;
    if (dayOnly) {
      const [year, month, day] = value.split('-').map(Number);
      const check = new Date(`${value}T00:00:00.000Z`);
      if (!Number.isFinite(check.getTime()) || check.toISOString().slice(0, 10) !== value)
        fail(400, 'El filtro contiene una fecha inexistente.');
      date = zonedDate(year, month, day, 0, 0);
      if (key === 'hasta') {
        // El día institucional puede durar 23 o 25 horas durante el cambio de horario.
        const next = new Date(Date.UTC(year, month - 1, day + 1));
        date = new Date(
          zonedDate(
            next.getUTCFullYear(),
            next.getUTCMonth() + 1,
            next.getUTCDate(),
            0,
            0,
          ).getTime() - 1,
        );
      }
    } else date = parseDateTime(value);
    range[side] = date;
  }
  if (range.gte && range.lte && range.gte > range.lte)
    fail(400, 'La fecha inicial debe ser anterior a la fecha final.');
  return Object.keys(range).length ? range : undefined;
}
function incidentWhere(query) {
  const where = {};
  const range = dateRange(query);
  if (range) where.creadoEn = range;
  const usuarioId = queryId(query.usuarioId);
  if (usuarioId) where.usuarioId = usuarioId;
  const materialId = queryId(query.materialId);
  if (materialId) where.piezaPrestamo = { pieza: { materialId } };
  if (query.estado) where.estado = String(query.estado);
  if (query.tipoIncidencia) where.tipo = String(query.tipoIncidencia);
  return where;
}
async function incidentList(query) {
  const rows = await prisma.incidencia.findMany({
    where: incidentWhere(query),
    include: INC_INCLUDE,
    orderBy: { creadoEn: 'desc' },
  });
  const ids = [...new Set(rows.map((r) => r.encargadoId))];
  const encargados = await prisma.usuario.findMany({ where: { id: { in: ids } }, select: USER });
  const users = new Map(encargados.map((u) => [u.id, u]));
  return rows.map((row) => ({
    ...row,
    encargado: users.get(row.encargadoId) || {
      id: row.encargadoId,
      nombre: 'Encargado registrado',
    },
  }));
}

async function buildReport(query) {
  const tipo = query.tipo || 'prestamos';
  if (!['prestamos', 'materiales', 'danados', 'perdidos', 'incidencias', 'adeudos'].includes(tipo))
    fail(400, 'Selecciona un tipo de reporte válido.');
  const usuarioId = queryId(query.usuarioId);
  const materialId = queryId(query.materialId);
  const range = dateRange(query);
  let filas = [];
  let estadisticas = {};
  if (tipo === 'prestamos' || tipo === 'materiales') {
    const where = {};
    if (usuarioId) where.usuarioId = usuarioId;
    if (range) where.fechaSolicitud = range;
    if (query.estado) {
      if (
        ![
          'PENDIENTE',
          'PREPARADA',
          'ENTREGADO',
          'DEVUELTO',
          'RECHAZADO',
          'CANCELADO',
          'NO_RECOGIDO',
          'INCIDENCIA',
        ].includes(query.estado)
      )
        fail(400, 'El estado de préstamo del filtro no es válido.');
      where.estado = query.estado;
    }
    if (materialId) where.OR = [{ piezas: { some: { pieza: { materialId } } } }, { materialId }];
    if (query.tipoIncidencia) where.incidencias = { some: { tipo: String(query.tipoIncidencia) } };
    const loans = await prisma.prestamo.findMany({
      where,
      include: {
        usuario: { select: USER },
        material: true,
        piezas: { include: { pieza: { include: { material: true } } } },
        incidencias: true,
      },
      orderBy: { fechaSolicitud: 'desc' },
    });
    estadisticas = {
      solicitudes: loans.length,
      piezasSolicitadas: loans.reduce(
        (sum, loan) => sum + (loan.piezas.length || loan.cantidad),
        0,
      ),
      prestamosActivos: loans.filter((p) => p.estado === 'ENTREGADO').length,
      conIncidencia: loans.filter((p) => p.incidencias.length).length,
    };
    if (tipo === 'prestamos')
      filas = loans.map((loan) => ({
        folio: loan.id,
        alumno: loan.usuario.nombre,
        matricula: loan.usuario.matricula,
        materiales: loan.piezas.length
          ? loan.piezas.map((p) => `${p.pieza.material.nombre} (${p.pieza.codigo})`).join('; ')
          : loan.material?.nombre || '',
        piezas: loan.piezas.length || loan.cantidad,
        estado: loan.estado,
        solicitud: loan.fechaSolicitud.toISOString(),
        recoleccion: loan.fechaRecoleccion?.toISOString() || '',
        entrega: loan.fechaEntrega?.toISOString() || '',
        devolver: loan.fechaDevolucion?.toISOString() || '',
        devuelto: loan.fechaDevuelto?.toISOString() || '',
        incidencias: loan.incidencias.length,
      }));
    else {
      const groups = new Map();
      for (const loan of loans) {
        const details = loan.piezas.length
          ? loan.piezas
              .filter((p) => !materialId || p.pieza.materialId === materialId)
              .map((p) => ({ material: p.pieza.material, cantidad: 1 }))
          : loan.material
            ? [{ material: loan.material, cantidad: loan.cantidad }]
            : [];
        const seen = new Set();
        for (const detail of details) {
          let entry = groups.get(detail.material.id);
          if (!entry) {
            entry = {
              materialId: detail.material.id,
              material: detail.material.nombre,
              categoria: detail.material.categoria,
              solicitudes: 0,
              piezasSolicitadas: 0,
              piezasEntregadas: 0,
            };
            groups.set(detail.material.id, entry);
          }
          if (!seen.has(detail.material.id)) {
            entry.solicitudes++;
            seen.add(detail.material.id);
          }
          entry.piezasSolicitadas += detail.cantidad;
          if (loan.fechaEntrega) entry.piezasEntregadas += detail.cantidad;
        }
      }
      filas = [...groups.values()].sort((a, b) => b.piezasSolicitadas - a.piezasSolicitadas);
    }
  } else if (['incidencias', 'danados', 'perdidos'].includes(tipo)) {
    const q = { ...query };
    if (tipo === 'perdidos') q.tipoIncidencia = 'PERDIDA';
    const incidents = await incidentList(q);
    const filtered =
      tipo === 'danados'
        ? incidents.filter((i) => !['PERDIDA', 'PERDIDO'].includes(i.tipo))
        : incidents;
    filas = filtered.map((i) => ({
      incidencia: i.id,
      folio: i.prestamoId,
      alumno: i.usuario.nombre,
      matricula: i.usuario.matricula,
      material: i.piezaPrestamo.pieza.material.nombre,
      codigo: i.piezaPrestamo.pieza.codigo,
      tipo: i.tipo,
      descripcion: i.descripcion,
      estado: i.estado,
      fecha: i.creadoEn.toISOString(),
      encargado: i.encargado.nombre,
      adeudo: i.adeudo?.estado || '',
      convenio:
        i.adeudo?.convenios.find((c) => c.estado === 'ACTIVO')?.fechaLimite.toISOString() || '',
    }));
    estadisticas = {
      incidencias: filas.length,
      pendientes: filtered.filter((i) => i.estado !== 'LIQUIDADA').length,
    };
  } else {
    const where = {};
    if (usuarioId) where.usuarioId = usuarioId;
    if (range) where.creadoEn = range;
    where.estado = query.estado ? String(query.estado) : { not: 'LIQUIDADO' };
    if (materialId || query.tipoIncidencia)
      where.incidencia = {
        ...(materialId ? { piezaPrestamo: { pieza: { materialId } } } : {}),
        ...(query.tipoIncidencia ? { tipo: String(query.tipoIncidencia) } : {}),
      };
    const debts = await prisma.adeudo.findMany({
      where,
      include: {
        usuario: { select: USER },
        incidencia: {
          include: { piezaPrestamo: { include: { pieza: { include: { material: true } } } } },
        },
        convenios: true,
      },
      orderBy: { creadoEn: 'desc' },
    });
    filas = debts.map((a) => ({
      adeudo: a.id,
      alumno: a.usuario.nombre,
      matricula: a.usuario.matricula,
      material: a.incidencia.piezaPrestamo.pieza.material.nombre,
      codigo: a.incidencia.piezaPrestamo.pieza.codigo,
      incidencia: a.incidenciaId,
      tipo: a.incidencia.tipo,
      estado: a.estado,
      creado: a.creadoEn.toISOString(),
      liquidado: a.liquidadoEn?.toISOString() || '',
      limiteConvenio:
        a.convenios
          .find((c) => ['ACTIVO', 'VENCIDO'].includes(c.estado))
          ?.fechaLimite.toISOString() || '',
      notas: a.notas || '',
    }));
    estadisticas = {
      adeudos: debts.length,
      alumnos: new Set(debts.map((d) => d.usuarioId)).size,
      vencidos: debts.filter((d) => d.estado === 'VENCIDO').length,
      liquidados: debts.filter((d) => d.estado === 'LIQUIDADO').length,
    };
  }
  return {
    tipo,
    columnas: filas.length ? Object.keys(filas[0]) : [],
    filas,
    total: filas.length,
    estadisticas,
    generadoEn: new Date().toISOString(),
  };
}

async function sendReport(res, report, format) {
  if (!format || format === 'json') return res.json(report);
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'CIMA';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Reporte');
    sheet.columns = report.columnas.map((key) => ({
      header: key,
      key,
      width: /material|descripcion|notas/.test(key) ? 45 : 24,
    }));
    for (const row of report.filas)
      sheet.addRow(
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safeCell(value)])),
      );
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF075B48' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    if (report.columnas.length)
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: report.columnas.length },
      };
    const summary = workbook.addWorksheet('Resumen');
    summary.addRows([
      ['Tipo', report.tipo],
      ['Generado', report.generadoEn],
      ['Registros', report.total],
      ...Object.entries(report.estadisticas),
    ]);
    const buffer = await workbook.xlsx.writeBuffer();
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment(`cima-${report.tipo}.xlsx`)
      .send(Buffer.from(buffer));
    return;
  }
  if (format !== 'pdf') fail(400, 'El formato de exportación debe ser json, pdf o xlsx.');
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: { Title: `CIMA: ${report.tipo}`, Author: 'CIMA' },
  });
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor('#075b48')
    .text(`CIMA · Reporte de ${report.tipo}`);
  doc
    .moveDown()
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#222222')
    .text(`Generado: ${report.generadoEn} | Registros: ${report.total}`);
  for (const [key, value] of Object.entries(report.estadisticas)) doc.text(`${key}: ${value}`);
  doc.moveDown();
  if (!report.filas.length)
    doc.text('No se encontraron resultados para los filtros seleccionados.');
  for (let index = 0; index < report.filas.length; index++) {
    if (doc.y > doc.page.height - 150) doc.addPage();
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(`Registro ${index + 1}`);
    doc.font('Helvetica').fontSize(9);
    for (const [key, value] of Object.entries(report.filas[index]))
      doc.text(`${key}: ${String(value ?? '')}`);
    doc.moveDown();
  }
  doc.end();
  const buffer = await finished;
  res.type('application/pdf').attachment(`cima-${report.tipo}.pdf`).send(buffer);
}

module.exports = {
  buildReport,
  sendReport,
  incidentList,
  incidentWhere,
  dateRange,
  queryId,
  USER,
  INC_INCLUDE,
};
