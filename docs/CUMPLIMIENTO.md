# Trazabilidad de requerimientos CIMA

Fuente: `Requerimientos.pdf`, secciones 2.9 y 3. Se implementan sus especificaciones como requisitos del producto. No se consideran instrucciones operativas para ejecutar acciones externas.

## Reglas de negocio

| Regla | Implementación y comportamiento |
| --- | --- |
| RN-01, RN-02 | `auth.js` y `cuentas.js`: sesión requerida, acceso por matrícula o correo; padrón y dominio institucional verificados |
| RN-03 | `core.eligibility`: cuenta/padrón activos, bloqueo administrativo, incidencias y préstamos o convenios vencidos |
| RN-04, RN-05 | Convenio vigente habilita solicitudes; se comprueba el plazo en cada solicitud y `automation.js` persiste vencimiento y notificación |
| RN-06 | Operaciones ordena por fechaSolicitud/id y sólo permite preparar la pendiente más antigua, dentro de transacción |
| RN-07 | Cancelación por propietario exclusivamente PENDIENTE; PREPARADA/ENTREGADO se rechazan |
| RN-08, RN-09 | Entrega exige PREPARADA, código de solicitud, identidad confirmada y todas las piezas correctas, sin duplicados |
| RN-10, RN-11 | Revisión física obligatoria por pieza; devolución con daño nuevo/pérdida genera incidencia y adeudo y deja préstamo INCIDENCIA |
| RN-12 | Defecto previo aprobado queda en historial; la misma condición no genera responsabilidad al devolver |
| RN-13 | Auditoría automática transaccional con actor, rol, fecha/hora, acción, módulo y detalle; tres categorías y trigger inmutable |
| RN-14 | Convenios y liquidaciones administrativas; sin pasarela ni API de pagos |
| RN-15, RN-16 | Middleware ADMIN para inventario/usuarios/convenios/reportes/log; ENCARGADO únicamente operación |
| RN-17 | Preparada vence en recolección+tolerancia; tarea cada 5 segundos y operación manual tras vencer liberan piezas y notifican |
| RN-18 | Suscripción de interés y notificación interna al recuperar disponibilidad |
| RN-19 | maxHoras por material; devolución elegida en ventanilla y limitada al menor máximo desde la entrega |
| RN-20 | Calendario del alumno deshabilita fines de semana; servidor valida horario/día; límite de devolución se ajusta al viernes anterior si corresponde |
| RN-21 | Aviso visible de uso interno y aceptación obligatoria de esa condición al solicitar |
| RN-22 | Importación completa desactiva ausentes y revoca sesiones; actualización sin duplicación ni pérdida de historial |

Cuando un defecto preexistente aceptado explica la condición de regreso, la pieza puede quedar en mantenimiento para revisión sin generar deuda al alumno. Las observaciones de salida también forman parte de la comparación. Un defecto distinto o pérdida sí genera responsabilidad. Una liquidación de adeudo no libera automáticamente una pieza pendiente de reparación.

La tolerancia inicial es 15 minutos y el administrador puede cambiarla conforme RF-ADM-05. La hora de recolección acordada determina su inicio conforme RN-17. Las notificaciones se entregan dentro de CIMA conforme RF-SIS-03; no se necesita proveedor de correo externo.

## Requerimientos funcionales

| Identificadores, incluidas sus subdivisiones | Módulo / archivos |
| --- | --- |
| RF-ADM-01 | Usuarios/Crear encargado/Editar, rutas `/api/admin/usuarios` |
| RF-ADM-02 | Usuarios y padrón, CSV/XLSX, validación previa, credenciales listas y semestre completo, `imports.js` y `administracion.js` |
| RF-ADM-03, RF-ADM-04 | Inventario y piezas, edición/revisión/baja, códigos únicos y carga masiva con resumen |
| RF-ADM-05 | Configuración persistente de tolerancia, horarios y anticipación |
| RF-ADM-06 | Incidencias con alumno/pieza/encargado y vale imprimible |
| RF-ADM-07 | Convenios, fechas y liquidación administrativa con evidencia y auditoría |
| RF-ADM-08 | Seis tipos de reportes, filtros y archivos PDF/XLSX reales, `reportes.js` |
| RF-ADM-09 | Bitácora exclusiva ADMIN, sólo lectura, trigger `prisma/invariants.sql` |
| RF-ADM-10 | Avisos globales activables visibles en alumno |
| RF-ENC-01 | Rol ENCARGADO, panel `operacion.html` y autorización servidor |
| RF-ENC-02, RF-ENC-03, RF-ENC-04 | Cola cronológica, preparación FIFO, notificación/código y cancelación por inasistencia |
| RF-ENC-05, RF-ENC-06 | Escaneo o ingreso por teclado de código de solicitud y cada pieza, identidad y estado de salida |
| RF-ENC-07, RF-ENC-08 | Devolución por códigos y condición, incidencias/adeudos, comprobante y orientación al administrador |
| RF-ENC-09 | Reporte de defecto previo, aceptación/rechazo y consideración en regreso |
| RF-ALU-01 | Inicio por matrícula/correo, padrón vigente y estado de elegibilidad claro |
| RF-ALU-02, RF-ALU-03 | Catálogo completo, búsqueda/categorías y estado sin coincidencias |
| RF-ALU-04, RF-ALU-05 | Carrito múltiple, stock reservado transaccional y cancelación pendiente |
| RF-ALU-06 | Código de solicitud único al preparar, visible al alumno; alternativa permitida al QR |
| RF-ALU-07 | Notificaciones internas persistentes de preparación, inasistencia, disponibilidad y próximos vencimientos |
| RF-ALU-08, RF-ALU-09, RF-ALU-10 | Historial con condiciones/fechas/defectos/incidencias y estado/plazo de convenios y adeudos |
| RF-ALU-11 | Sugerencias por práctica administrables y agregables al carrito según stock |
| RF-SIS-01, RF-SIS-02, RF-SIS-03 | Automatización cada 5 segundos y comprobación sincrónica de elegibilidad; stock y eventos persistentes |
| RF-SIS-04 | Transacciones serializables, actualizaciones condicionadas y reintento de conflictos sobre última unidad |

## Requerimientos no funcionales

| Identificadores | Solución y verificación |
| --- | --- |
| RNF-USA-01…06 | Diseño responsivo, calendario hábil, lector como teclado, mensajes legibles, confirmaciones críticas y navegación por rol |
| RNF-FIA-01, 03, 04, 05 | Transacciones; transición estricta PENDIENTE→PREPARADA→ENTREGADO; historial por estados y validación completa antes de importación |
| RNF-FIA-02 | `backup.js`, pg_dump custom al iniciar/cada hora cuando último supera 23h; comprobante de resultado y manual de restauración |
| RNF-REN-01…05 | Índices de catálogo/cola/fechas, consultas agrupadas, actualización cada 5s, exportación en servidor; pruebas funcionales de concurrencia y medición de catálogo local |
| RNF-SOP-01…05 | Separación rutas/servicios/modelos/vistas, comentarios de invariantes, manual técnico y de usuario, reportes/automatizaciones extensibles |
| RNF-SEG-01…04, 06, 07 | bcrypt, JWT con expiración/revocación, padrón vivo y roles servidor, secreto aleatorio, errores sin detalles sensibles |
| RNF-SEG-05 | HTTPS local con redirección; TLS1.2+, HSTS; producción requiere certificados institucionales confiables o proxy HTTPS configurado |
| RNF-RES-01…07 | Aplicación web conectada, sin modo offline ni pagos, liquidaciones administrativas, lectores estándar y alumnos de dominio institucional |

El tiempo objetivo de catálogo de 2 segundos debe verificarse también en la red y hardware de destino con el volumen institucional. Las pruebas locales no certifican una carga máxima ni sustituyen la medición de producción. El respaldo diario requiere que el servicio o la tarea programada estén activos y que pg_dump y el almacenamiento sean accesibles. La emisión de un certificado confiable para el dominio institucional corresponde al despliegue; se incluye configuración y certificado de desarrollo.

## Evidencia reproducible

- `npm test`: autenticación/roles, stock concurrente, FIFO y transiciones, códigos/identidad, calendario/límites, condiciones físicas, defectos, adeudos/convenios/vencimientos, notificaciones, CSV/XLSX, PDF/XLSX, auditoría y reemplazo semestral con rollback.
- `npm run test:smoke`: HTTPS de la instancia activa, salud y autorización de roles.
- `npm run test:ui`: navegación real, interacción de roles y diseño móvil.
- `npm run backup`: archivo PostgreSQL restaurable; puede verificarse con `pg_restore --list`.

Las acciones de prueba permanecen en bitácora porque su inmutabilidad es parte del requisito. Los datos de negocio temporales se eliminan al finalizar cada suite.
