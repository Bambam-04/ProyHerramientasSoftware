require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { prisma, transaction } = require('../src/lib/core');
// Conserva préstamos previos al introducir la identificación individual de piezas.
async function prepare() {
  await prisma.configuracion.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  await transaction(async (tx) => {
    const busy = await tx.prestamoPieza.findMany({
      where: { prestamo: { estado: { in: ['PENDIENTE', 'PREPARADA', 'ENTREGADO'] } } },
      select: { piezaId: true },
    });
    const used = new Set(busy.map((item) => item.piezaId));
    const materials = await tx.material.findMany({
      include: {
        piezas: true,
        prestamos: { include: { piezas: true }, orderBy: { fechaSolicitud: 'asc' } },
      },
    });
    for (const material of materials) {
      let pieces = material.piezas;
      const activeCount = pieces.filter((p) => !['BAJA', 'PERDIDA'].includes(p.estado)).length;
      const missing = !pieces.length
        ? material.cantidadTotal
        : material.estado === 'BAJA'
          ? 0
          : Math.max(0, material.cantidadTotal - activeCount);
      if (missing) {
        if (material.cantidadTotal < 0 || material.cantidadTotal > 10000)
          throw new Error('Revisa la cantidad del inventario previo antes de migrarlo.');
        await tx.pieza.createMany({
          data: Array.from({ length: missing }, () => ({
            materialId: material.id,
            codigo: `CIMA-${material.id}-${randomUUID().slice(0, 12).toUpperCase()}`,
            estado:
              material.estado === 'BAJA'
                ? 'BAJA'
                : material.estado === 'MANTENIMIENTO'
                  ? 'MANTENIMIENTO'
                  : 'DISPONIBLE',
          })),
        });
        pieces = await tx.pieza.findMany({
          where: { materialId: material.id },
          orderBy: { id: 'asc' },
        });
      }
      for (const p of material.prestamos) {
        const metadata = {};
        if (!p.codigo && p.estado !== 'PENDIENTE')
          metadata.codigo = `CIMA-${randomUUID().toUpperCase()}`;
        if (!p.fechaRecoleccion) metadata.fechaRecoleccion = p.fechaEntrega || p.fechaSolicitud;
        if (Object.keys(metadata).length)
          await tx.prestamo.update({ where: { id: p.id }, data: metadata });
        const missingLinks = p.cantidad - p.piezas.length;
        if (missingLinks <= 0) continue;
        const live = ['PENDIENTE', 'PREPARADA', 'ENTREGADO'].includes(p.estado);
        const linked = new Set(p.piezas.map((item) => item.piezaId));
        const selected = pieces
          .filter(
            (piece) =>
              !linked.has(piece.id) &&
              (!live ||
                (!used.has(piece.id) &&
                  !['RESERVADA', 'PRESTADA', 'BAJA', 'PERDIDA'].includes(piece.estado))),
          )
          .slice(0, missingLinks);
        if (selected.length !== missingLinks)
          throw new Error(
            `El préstamo previo #${p.id} excede las piezas libres del inventario. Resuélvelo antes de continuar.`,
          );
        for (const piece of selected) {
          await tx.prestamoPieza.create({
            data: {
              prestamoId: p.id,
              piezaId: piece.id,
              condicionEntrega: p.condicionEntrega,
              condicionDevuelto: p.condicionDevuelto,
              notasEntrega: p.notasEntrega,
              notasDevuelto: p.notasDevuelto,
              devuelta: p.estado === 'DEVUELTO',
            },
          });
          if (live) {
            used.add(piece.id);
            await tx.pieza.update({
              where: { id: piece.id },
              data: { estado: p.estado === 'ENTREGADO' ? 'PRESTADA' : 'RESERVADA' },
            });
          }
        }
      }
    }
  });
  // $executeRaw no admite varios statements. Conserva el cuerpo de la función como unidad.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'invariants.sql'), 'utf8');
  const functionEnd = sql.indexOf('$$ LANGUAGE plpgsql;') + '$$ LANGUAGE plpgsql;'.length;
  await prisma.$executeRawUnsafe(sql.slice(0, functionEnd));
  for (const statement of sql
    .slice(functionEnd)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean))
    await prisma.$executeRawUnsafe(statement);
}
if (require.main === module)
  prepare()
    .then(() =>
      console.log('Piezas individuales y auditoría inmutable preparadas; historial conservado.'),
    )
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
module.exports = { prepare };
