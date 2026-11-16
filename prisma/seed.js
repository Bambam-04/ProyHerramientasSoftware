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
    create: {
      matricula: '0000001',
      nombre: 'Administrador CIMA',
      correo: `admin@${dominio}`,
      passwordHash: hash('Admin1234'),
      rol: 'ADMIN',
    },
  });
  const alumno = await prisma.usuario.upsert({
    where: { correo: `alumno@${dominio}` },
    update: {},
    create: {
      matricula: '1234567',
      nombre: 'Ana López Ruiz',
      correo: `alumno@${dominio}`,
      passwordHash: hash('Alumno1234'),
      rol: 'ALUMNO',
    },
  });
  await prisma.usuario.upsert({
    where: { correo: `ventanilla@${dominio}` },
    update: {},
    create: {
      matricula: 'ENC-DEMO',
      nombre: 'Encargado de Ventanilla',
      correo: `ventanilla@${dominio}`,
      passwordHash: hash('Ventanilla1234'),
      rol: 'ENCARGADO',
    },
  });
  await prisma.usuario.upsert({
    where: { correo: `docente@${dominio}` },
    update: {},
    create: {
      matricula: '1111111',
      nombre: 'Dr. Mario Peña',
      correo: `docente@${dominio}`,
      passwordHash: hash('Docente1234'),
      rol: 'DOCENTE',
    },
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
  }
  const examples = [
    [
      'Microscopio óptico',
      'Óptica',
      'Microscopio para observación de muestras en el laboratorio.',
      4,
    ],
    [
      'Multímetro digital',
      'Medición',
      'Medición de voltaje, corriente y resistencia eléctrica.',
      8,
    ],
    ['Balanza analítica', 'Medición', 'Balanza de precisión; mantener nivelada y limpia.', 4],
    [
      'Matraz Erlenmeyer 250 ml',
      'Cristalería',
      'Matraz de vidrio de 250 ml para prácticas de laboratorio.',
      24,
    ],
    ['Kit de pipetas', 'Cristalería', 'Kit para medición y transferencia de líquidos.', 24],
    [
      'Espectrofotómetro',
      'Medición',
      'Equipo para análisis de absorbancia; requiere revisión de mantenimiento.',
      4,
    ],
  ];
  for (const [nombre, categoria, caracteristicas, maxHoras] of examples) {
    await prisma.material.updateMany({
      where: { nombre, categoria: 'General', caracteristicas: '' },
      data: { categoria, caracteristicas, maxHoras, fotografia: '/material-placeholder.svg' },
    });
  }
  console.log('Datos de prueba listos.');
}

main()
  .catch((error) => {
    console.error('No se pudieron preparar los datos de demostración:', error.code || error.name);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
