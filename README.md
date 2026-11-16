# CIMA · Almacén FCQI

Aplicación web de inventario y préstamos por pieza, con módulos de Alumno, Encargado de Ventanilla y Administrador. Express sirve la interfaz y la API; Prisma conecta a PostgreSQL.

## Ejecutar

Requiere Node.js 22 x64 o posterior, PostgreSQL activo, una base `cima` y OpenSSL para generar el certificado de desarrollo. En Windows ARM64, `scripts/run.js` selecciona Node x64 de fnm; también admite `CIMA_NODE_PATH`. En este equipo se utiliza PostgreSQL 18 y OpenSSL de Git.

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd install
```

Configura `DATABASE_URL` en `.env` con tus credenciales. Después:

```powershell
npm.cmd run setup
npm.cmd start
```

Abre **[https://localhost:3443](https://localhost:3443)**. El puerto 3000 redirige a HTTPS. El certificado local es autofirmado: el navegador pedirá aceptarlo en el entorno de desarrollo. Para publicar en la red institucional se debe configurar un certificado confiable para el dominio y `NODE_ENV=production`; véase el [manual técnico](docs/MANUAL_TECNICO.md).

La preparación genera un secreto de sesión aleatorio y un certificado local, amplía el esquema conservando el historial, identifica cada pieza y protege la bitácora contra modificaciones. La carga inicial conserva cuentas existentes. No se aceptan automáticamente operaciones que destruyan datos.

## Funcionalidad

- Catálogo con búsqueda, categorías, imágenes, características, disponibilidad y límite de préstamo; carrito de varios materiales y calendario de días hábiles.
- Reservas transaccionales, cola FIFO, preparación, código de recolección, identidad y lectura de cada pieza.
- Devoluciones con estado físico, defectos previos, comprobantes de incidencia, adeudos y convenios de reposición.
- Usuarios y padrón semestral, importaciones CSV/XLSX con validación previa, inventario por pieza, reglas y avisos.
- Notificaciones internas, vencimiento de convenios, liberación por inasistencia y recordatorios automáticos.
- Reportes filtrados y exportación PDF/XLSX; auditoría inmutable y respaldos automáticos diarios con `pg_dump`.

## Cuentas locales de demostración

| Rol | Identificador | Contraseña |
| --- | --- | --- |
| Administrador | admin@uabc.edu.mx | Admin1234 |
| Ventanilla | ventanilla@uabc.edu.mx | Ventanilla1234 |
| Alumno | alumno@uabc.edu.mx o 1234567 | Alumno1234 |
| Docente heredado | docente@uabc.edu.mx | Docente1234 |

Usa el dominio configurado en `DOMINIO_INSTITUCIONAL`. Cambia las credenciales de demostración antes de publicar. Las cuentas importadas se crean automáticamente y reciben credenciales temporales; sólo deben cambiar la contraseña al primer ingreso. El rol docente se conserva para los datos del prototipo y utiliza las funciones del alumno. Los préstamos vencidos que ya existían siguen restringiendo solicitudes hasta registrar su devolución.

## Validación y respaldo

```powershell
npm.cmd test             # API, PostgreSQL, concurrencia, reglas y exportaciones
npm.cmd run test:smoke   # Instancia HTTPS activa y permisos de los tres roles
npm.cmd run test:ui      # Navegador Edge/Chromium, interfaz móvil y flujos de roles
npm.cmd run backup      # Respaldo adicional inmediato
```

Las pruebas integrales crean registros temporales y los eliminan; conservan sus acciones en la bitácora inmutable. La prueba de reemplazo de semestre se revierte en una transacción para conservar el padrón real. Ejecuta una suite a la vez: la cola FIFO es compartida. `test:ui` utiliza Edge instalado o `CIMA_BROWSER_PATH`.

## Documentación

- [Instalación, arquitectura, HTTPS y respaldo/restauración](docs/MANUAL_TECNICO.md)
- [Manual de administradores y ventanilla](docs/MANUAL_USUARIO.md)
- [Correspondencia con las reglas y requerimientos del PDF](docs/CUMPLIMIENTO.md)
- [Plantilla de alumnos](docs/plantillas/alumnos.csv) y [plantilla de inventario](docs/plantillas/materiales.csv)

CIMA requiere conexión al servidor y PostgreSQL; el material se usa exclusivamente dentro del plantel. Las liquidaciones son registros administrativos y no procesan pagos electrónicos.
