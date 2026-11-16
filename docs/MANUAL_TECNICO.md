# Manual técnico CIMA

## Arquitectura

`src/app.js` configura HTTP, cabeceras de seguridad, validaciones y errores. `src/server.js` inicia HTTPS, redirección HTTP, tareas automáticas y cierre de conexiones. Separar la aplicación del arranque permite probar en un puerto temporal.

| Archivo | Responsabilidad |
| --- | --- |
| `src/routes/cuentas.js` | Acceso por matrícula/correo, contraseña, sesión y estado de cuenta |
| `src/routes/operaciones.js` | Catálogo, solicitudes, ventanilla, piezas, defectos y notificaciones |
| `src/routes/administracion.js` | Usuarios, importaciones, inventario, convenios, avisos y configuración |
| `src/lib/core.js` | Transacciones serializables con reintentos, elegibilidad, horarios, disponibilidad y trazabilidad |
| `src/lib/auth.js` | JWT HS256 con emisor, audiencia, expiración y revocación por versión |
| `src/lib/automation.js` | Inasistencia, convenios vencidos y recordatorios, cada 5 segundos |
| `src/lib/imports.js`, `reportes.js` | CSV/XLSX, validación, PDF y Excel |
| `prisma/schema.prisma` | Modelo persistente e índices de consulta |
| `prisma/invariants.sql` | Trigger que impide UPDATE/DELETE/TRUNCATE de auditoría |
| `scripts/prepare.js` | Conversión idempotente del inventario previo a piezas individuales |
| `scripts/backup.js` | Respaldo PostgreSQL en formato custom |
| `public/` | HTML/CSS/JavaScript por rol, sin compilación ni dependencias de CDN |

Un material agrupa piezas con código único. Un préstamo agrupa registros `PrestamoPieza`; cada registro conserva su revisión de salida y regreso. Incidencias, adeudos y convenios se relacionan sin borrar el historial. La disponibilidad se consulta en las piezas; las reservas condicionan la actualización a su estado anterior y se confirman en transacciones serializables. Las transacciones reintentan conflictos de concurrencia, con una respuesta clara si se agotan los reintentos.

## Instalación

1. Instala Node.js 22 x64 o posterior, npm y PostgreSQL. Crea una base vacía llamada `cima` con un usuario autorizado para crear sus tablas, índices y trigger.
2. Copia `.env.example` a `.env` sólo si no existe. Establece `DATABASE_URL`, por ejemplo `postgresql://usuario:contraseña@localhost:5432/cima`. Codifica caracteres especiales de usuario/contraseña como URL.
3. Ejecuta `npm.cmd install` y `npm.cmd run setup`. En Linux/macOS puede utilizarse `npm` en lugar de `npm.cmd`.
4. Ejecuta `npm.cmd start` y abre `https://localhost:3443`.

En Windows ARM64, Prisma 5 necesita Node x64. El lanzador busca instalaciones fnm y admite `CIMA_NODE_PATH`. `scripts/configure-local.js` busca OpenSSL en `OPENSSL_PATH`, Git para Windows y PATH. Se utiliza una configuración OpenSSL propia para no depender de ajustes de PostgreSQL/ODBC.

La preparación no sustituye contraseñas existentes ni elimina registros de negocio. Antes de actualizar una instalación con datos, ejecuta `npm.cmd run backup`. Después detén CIMA, ejecuta `npm.cmd run setup` y arranca de nuevo; en Windows el proceso anterior puede mantener cargada la DLL de Prisma y bloquear su regeneración. Nunca uses `prisma migrate reset` en una instalación con historial.

`db:push` sincroniza el esquema sin `--accept-data-loss`. La nueva columna nullable `Prestamo.codigo` y su índice se agregan explícitamente para evitar el aviso genérico de Prisma sobre un índice único; no se alteran valores anteriores. `db:prepare` asigna códigos y piezas a los préstamos heredados, conservando sus condiciones y fechas. Ante inventario histórico inconsistente, la preparación se detiene para que se resuelva antes de arrancar.

## Configuración

| Variable | Uso |
| --- | --- |
| `DATABASE_URL` | Conexión PostgreSQL |
| `JWT_SECRET` | Secreto aleatorio; `setup` lo genera si está vacío o conserva el marcador anterior |
| `DOMINIO_INSTITUCIONAL` | Dominio exacto permitido para alumnos, por defecto `uabc.edu.mx` |
| `CIMA_TIMEZONE` | Zona institucional, por defecto `America/Tijuana` |
| `SESSION_TTL` | Expiración JWT, por defecto `2h` |
| `PORT`, `HTTPS_PORT` | HTTP de redirección y HTTPS; por defecto 3000/3443 |
| `HOST` | Interfaz de escucha, por defecto `127.0.0.1`; usar `0.0.0.0` al publicar en LAN |
| `TLS_KEY_FILE`, `TLS_CERT_FILE` | Clave privada y certificado PEM |
| `PUBLIC_ORIGIN` | URL HTTPS final usada por la redirección |
| `NODE_ENV` | `production` exige conexión HTTPS |
| `TRUST_PROXY` | Número de proxies confiables; configurar sólo tras un proxy administrado |
| `PG_DUMP_PATH` | Ejecutable pg_dump compatible con la versión de PostgreSQL |
| `BACKUP_DIR` | Carpeta protegida de respaldos, por defecto `.local/backups` |

Los horarios, tolerancia, anticipación y recordatorios se guardan en la tabla Configuracion y se editan desde Administración. El valor inicial de tolerancia es de 15 minutos. Una solicitud preparada vence a la hora acordada de recolección más la tolerancia vigente al prepararla. Se controla exclusivamente el fin de semana; no hay calendario automático de festivos.

## HTTPS y publicación institucional

El certificado generado en `.local/tls` es de desarrollo y dura 365 días. Los puertos y rutas actuales se guardan en `.env`, que no debe publicarse. Para uso institucional, configura un certificado válido emitido para el dominio en `TLS_CERT_FILE`/`TLS_KEY_FILE`, `PUBLIC_ORIGIN`, `HOST` y `NODE_ENV=production`. CIMA sirve TLS 1.2 o superior y envía HSTS en HTTPS. Las claves y respaldos deben tener permisos de acceso exclusivos del servicio y administradores autorizados.

También puede terminarse TLS en un proxy institucional: quita las variables TLS del servicio, configura `TRUST_PROXY` con el número real de proxies y expón el puerto interno sólo al proxy. El proxy debe enviar `X-Forwarded-Proto: https`; en producción la aplicación rechaza solicitudes inseguras con HTTP 426. No confíes en cabeceras provenientes directamente de clientes públicos.

Las contraseñas se protegen con bcrypt. Los JWT no incluyen contraseña ni hash. La API comprueba el usuario y padrón actuales en cada solicitud y revoca sesiones al cambiar credenciales o estado. Cinco contraseñas incorrectas bloquean la cuenta por cinco minutos; existe además un límite de intentos por IP. Las credenciales temporales sólo permiten consultar la cuenta y cambiar la contraseña. El navegador guarda la sesión por pestaña y requiere iniciar sesión tras su cierre.

## Respaldos y restauración

`npm.cmd run backup` ejecuta `pg_dump` con `--format=custom --no-owner`, sin poner contraseñas en argumentos. Los archivos se escriben primero como `.partial` y se renombran sólo al finalizar. `estado.json` registra el último resultado. El servicio comprueba el respaldo al iniciar y cada hora; genera uno nuevo cuando el último tiene al menos 23 horas, asegurando una periodicidad máxima de 24 horas mientras el servicio permanece activo. Se requiere PostgreSQL y `pg_dump` disponibles; un error se registra en consola y en `estado.json` para intervención operativa.

Para mantener respaldos cuando CIMA esté detenido, configura el Programador de tareas de Windows o cron para ejecutar `npm run backup` cada día desde la raíz del proyecto, con la misma cuenta y variables de entorno del servicio. La retención y copia de archivos a almacenamiento externo deben ajustarse a la política institucional; el sistema no elimina respaldos automáticamente.

Verifica el archivo con `pg_restore --list ruta/al/respaldo.dump`. Para restaurar, detén CIMA, crea una base vacía distinta y ejecuta:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\createdb.exe' -h localhost -U postgres cima_restaurada
& 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' -h localhost -U postgres --no-owner --dbname cima_restaurada '.local/backups/cima-FECHA.dump'
```

El cliente solicitará las credenciales de PostgreSQL. Apunta `DATABASE_URL` a la base restaurada, ejecuta `npm run db:prepare` y comprueba `/api/health`, préstamos, piezas y bitácora antes de volver a abrir el acceso. Conserva la base anterior hasta validar la restauración.

## Pruebas y operación

`npm test` levanta `src/app.js` en un puerto temporal y usa un reloj de lunes para verificar los flujos laborales sin cambiar el reloj del sistema. Las fixtures son únicas y se eliminan al terminar; la auditoría se conserva. La sustitución del padrón semestral se prueba con rollback deliberado. No ejecutes dos suites simultáneamente: FIFO es global. `npm run test:ui` prueba la interfaz en Edge/Chromium y `npm run test:smoke` consulta la instancia HTTPS desplegada localmente.

En una instalación de uso real, ejecuta las pruebas de integración en una base separada con el mismo esquema. Las pruebas funcionales confirman consistencia y concurrencia básica; los objetivos de catálogo de 2 segundos y carga de múltiples usuarios deben medirse también con el volumen y red institucionales antes del despliegue. Los índices cubren catálogo, cola, usuario, vencimientos y bitácora. El frontend actualiza sus consultas cada cinco segundos sin rehacer formularios en edición.

`/api/health` confirma acceso a la base. Revisa los registros del servicio y `.local/backups/estado.json`. Para detener una ejecución en terminal utiliza Ctrl+C; el cierre deja de aceptar conexiones, cancela temporizadores y desconecta Prisma. Un administrador no debe borrar préstamos ni bitácora: los módulos utilizan estados para conservar el historial.

## Ampliaciones

Las nuevas operaciones deben usar `transaction`, `audit`, `notify` y las reglas de `core`. Agrega nuevos tipos de reporte en `buildReport`; conserva autorización ADMIN. Las notificaciones internas se persisten en Notificacion y pueden ampliarse con un adaptador institucional de correo. Los lectores estándar funcionan como teclado; el sistema acepta códigos de solicitud y de piezas sin depender de un periférico específico.
