require('dotenv').config();
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { prisma } = require('../src/lib/core');
async function main() {
  // Índice sobre una columna nueva y nullable: no elimina ni altera datos previos.
  // Evita el aviso genérico de pérdida de datos de db push al agregar un índice UNIQUE.
  await prisma.$executeRawUnsafe(
    `DO $$ BEGIN IF to_regclass('public."Prestamo"') IS NOT NULL THEN ALTER TABLE "Prestamo" ADD COLUMN IF NOT EXISTS "codigo" TEXT; CREATE UNIQUE INDEX IF NOT EXISTS "Prestamo_codigo_key" ON "Prestamo"("codigo"); END IF; END $$;`,
  );
  await prisma.$disconnect();
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js'),
      'db',
      'push',
      '--skip-generate',
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status)
    throw new Error(
      'No se sincronizó el esquema; revisa el mensaje anterior. No se aceptan pérdidas de datos automáticamente.',
    );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
