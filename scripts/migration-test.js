// Regresión: nunca reasignar piezas ocupadas al completar una migración parcial.
require('dotenv').config();
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { prisma } = require('../src/lib/core');
const { prepare } = require('./prepare');
const prefix = `migration-${randomUUID()}`;
let user;
const materialIds = [];
async function main() {
  user = await prisma.usuario.create({
    data: {
      matricula: prefix,
      nombre: prefix,
      correo: `${prefix}@example.invalid`,
      rol: 'ALUMNO',
      passwordHash: 'fixture-sin-acceso',
    },
  });
  const m = await prisma.material.create({ data: { nombre: prefix, cantidadTotal: 2 } });
  materialIds.push(m.id);
  const a = await prisma.pieza.create({
    data: { materialId: m.id, codigo: `${prefix}-a`, estado: 'RESERVADA' },
  });
  const migrated = await prisma.prestamo.create({
    data: {
      usuarioId: user.id,
      materialId: m.id,
      cantidad: 1,
      estado: 'PREPARADA',
      piezas: { create: { piezaId: a.id } },
    },
  });
  const legacy = await prisma.prestamo.create({
    data: { usuarioId: user.id, materialId: m.id, cantidad: 1, estado: 'PREPARADA' },
  });
  const partialMaterial = await prisma.material.create({
    data: { nombre: prefix + 'partial', cantidadTotal: 3 },
  });
  materialIds.push(partialMaterial.id);
  const pieces = [];
  for (let i = 0; i < 3; i++)
    pieces.push(
      await prisma.pieza.create({
        data: {
          materialId: partialMaterial.id,
          codigo: `${prefix}-${i}`,
          estado: i === 0 ? 'PRESTADA' : 'DISPONIBLE',
        },
      }),
    );
  const partial = await prisma.prestamo.create({
    data: {
      usuarioId: user.id,
      materialId: partialMaterial.id,
      cantidad: 2,
      estado: 'ENTREGADO',
      piezas: { create: { piezaId: pieces[0].id } },
    },
  });
  await prepare();
  const first = await prisma.prestamo.findUnique({
    where: { id: migrated.id },
    include: { piezas: true },
  });
  const second = await prisma.prestamo.findUnique({
    where: { id: legacy.id },
    include: { piezas: true },
  });
  const third = await prisma.prestamo.findUnique({
    where: { id: partial.id },
    include: { piezas: true },
  });
  assert.equal(first.piezas[0].piezaId, a.id, 'Una asociación anterior debe conservarse.');
  assert.equal(second.piezas.length, 1);
  assert.notEqual(
    second.piezas[0].piezaId,
    a.id,
    'No reasignar una pieza reservada por otro préstamo.',
  );
  assert.equal(third.piezas.length, 2);
  assert.equal(third.piezas.filter((d) => d.piezaId === pieces[0].id).length, 1);
  const snapshot = await prisma.prestamoPieza.findMany({
    where: { prestamo: { usuarioId: user.id } },
    orderBy: { id: 'asc' },
  });
  await prepare();
  assert.deepEqual(
    await prisma.prestamoPieza.findMany({
      where: { prestamo: { usuarioId: user.id } },
      orderBy: { id: 'asc' },
    }),
    snapshot,
    'Preparar dos veces no debe duplicar ni alterar asociaciones.',
  );
  console.log(
    'Migración parcial: piezas ocupadas protegidas, asociaciones completadas e idempotencia verificadas.',
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (user) {
      const loans = await prisma.prestamo.findMany({
        where: { usuarioId: user.id },
        select: { id: true },
      });
      await prisma.$transaction([
        prisma.prestamoPieza.deleteMany({ where: { prestamoId: { in: loans.map((p) => p.id) } } }),
        prisma.prestamo.deleteMany({ where: { usuarioId: user.id } }),
        prisma.pieza.deleteMany({ where: { materialId: { in: materialIds } } }),
        prisma.material.deleteMany({ where: { id: { in: materialIds } } }),
        prisma.usuario.delete({ where: { id: user.id } }),
      ]);
    }
    await prisma.$disconnect();
  });
