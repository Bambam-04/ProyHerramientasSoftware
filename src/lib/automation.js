const { prisma, transaction, audit, notify, notifyAvailability, config, now } = require('./core');
let active = false;
async function runAutomation({ usuarioIds } = {}) {
  if (active) return;
  active = true;
  const scope = usuarioIds ? { usuarioId: { in: usuarioIds } } : {};
  try {
    const expired = await prisma.prestamo.findMany({
      where: { ...scope, estado: 'PREPARADA', limiteRecogida: { lt: now() } },
      select: { id: true },
    });
    for (const { id } of expired)
      await transaction(async (tx) => {
        const p = await tx.prestamo.findUnique({
          where: { id },
          include: { piezas: { include: { pieza: true } } },
        });
        if (p.estado !== 'PREPARADA' || !p.limiteRecogida || p.limiteRecogida >= now()) return;
        const changed = await tx.prestamo.updateMany({
          where: { id, estado: 'PREPARADA' },
          data: { estado: 'NO_RECOGIDO' },
        });
        if (!changed.count) return;
        await tx.pieza.updateMany({
          where: { id: { in: p.piezas.map((d) => d.piezaId) }, estado: 'RESERVADA' },
          data: { estado: 'DISPONIBLE' },
        });
        await notify(
          tx,
          p.usuarioId,
          'NO_RECOGIDO',
          `La solicitud ${p.codigo || p.id} se canceló por no recogerla dentro del tiempo de tolerancia.`,
          `no-recogido-${id}`,
        );
        await audit(tx, null, 'CANCELACION_AUTOMATICA_INASISTENCIA', 'PRESTAMOS', {
          prestamoId: id,
        });
        for (const materialId of new Set(p.piezas.map((d) => d.pieza.materialId)))
          await notifyAvailability(tx, materialId);
      });
    const convenios = await prisma.convenio.findMany({
      where: { ...scope, estado: 'ACTIVO', fechaLimite: { lt: now() } },
      select: { id: true },
    });
    for (const { id } of convenios)
      await transaction(async (tx) => {
        const c = await tx.convenio.findUnique({ where: { id }, include: { adeudo: true } });
        if (c.estado !== 'ACTIVO' || c.fechaLimite >= now() || c.adeudo.estado === 'LIQUIDADO')
          return;
        const changed = await tx.convenio.updateMany({
          where: { id, estado: 'ACTIVO' },
          data: { estado: 'VENCIDO' },
        });
        if (!changed.count) return;
        await tx.adeudo.update({ where: { id: c.adeudoId }, data: { estado: 'VENCIDO' } });
        await notify(
          tx,
          c.usuarioId,
          'ADEUDO_VENCIDO',
          'Tu convenio de reposición venció. Las nuevas solicitudes están bloqueadas. Acude con el administrador.',
          `convenio-vencido-${id}`,
        );
        await audit(tx, null, 'CONVENIO_VENCIDO_BLOQUEO', 'USUARIOS', {
          convenioId: id,
          usuarioId: c.usuarioId,
          adeudoId: c.adeudoId,
        });
      });
    const cfg = await config();
    const soon = await prisma.prestamo.findMany({
      where: {
        ...scope,
        estado: 'ENTREGADO',
        fechaDevolucion: { lte: new Date(now().getTime() + cfg.avisoVencimientoMinutos * 60000) },
      },
      select: { id: true, usuarioId: true, fechaDevolucion: true },
    });
    for (const p of soon)
      await transaction(async (tx) => {
        const overdue = p.fechaDevolucion < now();
        await notify(
          tx,
          p.usuarioId,
          overdue ? 'PRESTAMO_VENCIDO' : 'POR_VENCER',
          overdue
            ? `El préstamo #${p.id} venció. Registra la devolución en ventanilla.`
            : `Tu préstamo #${p.id} está próximo a vencer. Devuélvelo a tiempo.`,
          `${overdue ? 'vencido' : 'proximo'}-${p.id}`,
        );
        await tx.prestamo.updateMany({
          where: { id: p.id, estado: 'ENTREGADO', fechaAvisoVencimiento: null },
          data: { fechaAvisoVencimiento: now() },
        });
      });
  } finally {
    active = false;
  }
}
module.exports = { runAutomation };
