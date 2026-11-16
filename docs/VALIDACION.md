# Validación realizada

Fecha local: 15 de noviembre de 2026. Entorno: Windows ARM64 con Node.js 22 x64 para Prisma 5.22, PostgreSQL 18, Edge real y zona institucional America/Tijuana.

| Comprobación | Resultado |
| --- | --- |
| `npm run setup` sobre la instalación existente | Correcto; sincronización sin pérdida de datos y preparación idempotente |
| `npm test` | 142 respuestas HTTP correctas; integridad de inventario, roles, calendarios, adeudos, importaciones y auditoría |
| Prueba de migración incluida en `npm test` | Conserva piezas ocupadas, completa migraciones parciales y no duplica asociaciones al repetir |
| Reemplazo semestral RN22 | Ruta real probada dentro de transacción revertida; padrón y usuarios existentes conservados |
| `npm run test:ui` | 26 comprobaciones en Edge; tres roles, alumno a 390 px, flujo de dos piezas y administración |
| Errores de navegador | Sin errores JavaScript, bloqueos CSP o respuestas de servidor 500 en los flujos probados |
| `npm run test:smoke` | 14 comprobaciones sobre https://localhost:3443; certificado TLS validado y permisos de tres roles |
| Respaldo actualizado | pg_dump custom generado y archivo verificado mediante pg_restore --list; 160 entradas de catálogo del archivo |
| Dependencias | La instalación final reporta 0 vulnerabilidades; override de uuid 11.1.1 para ExcelJS |
| Modelo Prisma | `prisma validate` correcto |

Las capturas de las pruebas están en `.local/ui/`. Las pruebas eliminan únicamente sus datos de negocio temporales y conservan sus acciones en la bitácora inmutable. Existe un respaldo previo a la ampliación del esquema y otro posterior con la estructura completa en `.local/backups/`.

La instancia se ejecuta con certificado local autofirmado. La publicación institucional requiere configurar certificados confiables y verificar rendimiento con el volumen y red de destino, como se explica en el manual técnico. No se realizó una prueba de carga institucional ni se sustituyó la base real para comprobar restauración; el archivo de respaldo fue generado e inspeccionado correctamente.
