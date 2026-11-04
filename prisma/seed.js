require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const dominio = process.env.DOMINIO_INSTITUCIONAL || 'uabc.edu.mx';
  const hash = (p) => bcrypt.hashSync(p, 10);

  // Padrón: 2 ya registrados + 1 libre para probar REG-01 + 1 inactivo para REG-03
  await prisma.padron.createMany({
    skipDuplicates: true,
    data: [
      { matricula: '1234567', nombre: 'Ana López Ruiz', rol: 'ALUMNO' },
      { matricula: '1111111', nombre: 'Dr. Mario Peña', rol: 'DOCENTE' },
      { matricula: '2345678', nombre: 'Luis Torres Vega', rol: 'ALUMNO' },
      { matricula: '9999999', nombre: 'Pedro Baja Inactivo', rol: 'ALUMNO', activo: false },
    ],
  });

  await prisma.usuario.upsert({
    where: { correo: `admin@${dominio}` },
    update: {},
    create: { matricula: '0000001', nombre: 'Administrador CIMA', correo: `admin@${dominio}`, passwordHash: hash('Admin1234'), rol: 'ADMIN' },
  });
  const alumno = await prisma.usuario.upsert({
    where: { correo: `alumno@${dominio}` },
    update: {},
    create: { matricula: '1234567', nombre: 'Ana López Ruiz', correo: `alumno@${dominio}`, passwordHash: hash('Alumno1234'), rol: 'ALUMNO' },
  });
  await prisma.usuario.upsert({
    where: { correo: `docente@${dominio}` },
    update: {},
    create: { matricula: '1111111', nombre: 'Dr. Mario Peña', correo: `docente@${dominio}`, passwordHash: hash('Docente1234'), rol: 'DOCENTE' },
  });

  if ((await prisma.material.count()) === 0) {
    await prisma.material.createMany({
      data: [
        { nombre: 'Microscopio óptico', cantidadTotal: 5 },
        { nombre: 'Multímetro digital', cantidadTotal: 10 },
        { nombre: 'Balanza analítica', cantidadTotal: 2 },
        { nombre: 'Matraz Erlenmeyer 250 ml', cantidadTotal: 20 },
        { nombre: 'Kit de pipetas', cantidadTotal: 3 },
        { nombre: 'Espectrofotómetro', cantidadTotal: 1, estado: 'MANTENIMIENTO' },
      ],
    });
    // Préstamo ya vencido para probar PRE-08
    const balanza = await prisma.material.findFirst({ where: { nombre: 'Balanza analítica' } });
    await prisma.prestamo.create({
      data: {
        usuarioId: alumno.id, materialId: balanza.id, cantidad: 1, estado: 'ENTREGADO',
        fechaEntrega: new Date(Date.now() - 5 * 86400000), fechaDevolucion: new Date(Date.now() - 86400000), condicionEntrega: 'BUENO',
      },
    });
  }
  console.log('Datos de prueba listos.');
}

main().finally(() => prisma.$disconnect());
