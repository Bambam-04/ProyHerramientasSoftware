# Manual de usuario CIMA

## Acceso y navegación

Abre la dirección HTTPS proporcionada por el almacén. Escribe correo y contraseña; el alumno también puede utilizar su matrícula. Cada rol entra a su módulo. Los alumnos deben estar activos en el padrón del semestre. Las cuentas nuevas se crean al importar la lista oficial y reciben una contraseña temporal del administrador; al ingresar deben cambiarla. El botón Contraseña permite cambios posteriores y Cerrar sesión termina el acceso.

Las fechas y horas se muestran en la zona del plantel. CIMA necesita conexión con el servidor; si una consulta falla, muestra el problema y se puede volver a intentar. No se usa como aplicación sin conexión.

## Administrador

### Encargados y alumnos

En **Usuarios y padrón**, elige **Crear encargado**, ingresa nombre, correo y contraseña, y guarda. En cada cuenta, **Editar** permite corregir datos, restablecer contraseña o activar/deshabilitar el acceso. La deshabilitación conserva los préstamos, incidencias y convenios. No se puede deshabilitar la propia cuenta administrativa.

Para cargar alumnos, abre **Cargar lista oficial de alumnos inscritos**. Descarga la plantilla CSV o prepara Excel `.xlsx` con matrícula, nombre, correo institucional, carrera, periodo o grupo y estado ACTIVO/INACTIVO. Los campos `password` y fotografía no son obligatorios; si no existe contraseña para un alumno nuevo, CIMA genera una temporal. No se admiten fórmulas en el archivo.

1. Selecciona el archivo y presiona **Validar lista**.
2. Revisa errores por fila y resumen. Corrige duplicados, campos incompletos o correos no institucionales antes de continuar; con errores no se guarda ningún alumno.
3. Marca **lista completa del nuevo semestre** únicamente cuando el archivo incluya todos los alumnos inscritos: los ausentes quedarán inactivos. Para actualizaciones parciales deja la casilla desmarcada.
4. Confirma la importación. Los alumnos existentes se actualizan; se conservan sus registros históricos.
5. Guarda las credenciales iniciales mostradas una sola vez y entrégalas mediante el procedimiento institucional. Puedes descargarlas en CSV y ocultarlas al terminar.

En **Consultar padrón del semestre** se muestran matrícula, carrera, periodo y estado de los alumnos cargados. Los usuarios importados ya tienen cuenta; no necesitan una activación individual.

### Inventario

En **Inventario**, **Agregar material** permite registrar nombre, categoría, características, fotografía y límite de préstamo en horas. La cantidad genera piezas individuales con códigos únicos. El catálogo del alumno se actualiza automáticamente.

**Editar** modifica los datos y cantidades. Para disminuir una cantidad, las unidades deben estar disponibles. Las piezas reservadas o prestadas se gestionan desde ventanilla y bloquean cambios de estado o baja del material. **Piezas** muestra los códigos físicos y permite registrar revisión, mantenimiento, baja, pérdida o regreso a Disponible. Al liberar una pieza se debe registrar una condición segura. El material del catálogo también debe estar activo para que sus piezas sean solicitables. Al cambiar un material de En mantenimiento a Activo, sus piezas íntegras vuelven a estar disponibles; las que tienen daño registrado siguen en mantenimiento hasta revisarlas en **Piezas**.

La carga masiva de inventario acepta CSV/XLSX con nombre, categoría, características, cantidad y maxHoras. Usa primero **Validar archivo** y después **Confirmar importación**. Si el material ya existe con el mismo nombre y categoría, las unidades se suman en lugar de duplicar el catálogo. Las piezas en mantenimiento no vuelven a estar disponibles al liquidar un convenio: se revisan por separado.

### Incidencias, adeudos y convenios

En **Incidencias y convenios**, filtra el tipo y estado para revisar alumno, pieza, fecha, descripción y encargado que registró el evento. **Comprobante** abre el vale imprimible con sus datos y espacios de firma.

Un daño nuevo o pérdida deja al alumno con incidencia pendiente. **Crear convenio** permite formalizar la reposición de un adeudo, con descripción y fecha/hora límite futuras. Durante su vigencia, el alumno puede seguir solicitando si no tiene otras restricciones. Cuando vence, se bloquean automáticamente nuevas solicitudes y se notifica al alumno.

Cuando se recibe la reposición o constancia, selecciona **Liquidar** en el convenio o adeudo, registra el comprobante y las observaciones, y confirma. El sistema actualiza el adeudo y la incidencia, conserva el historial y recalcula la elegibilidad. Si no quedan incidencias pendientes del préstamo, éste se cierra administrativamente. CIMA no cobra ni procesa pagos electrónicos.

### Reglas, avisos, prácticas, reportes y bitácora

**Configuración** define tolerancia de recolección (inicialmente 15 minutos), anticipación mínima/máxima, horario y minutos de aviso antes del vencimiento. Las solicitudes nuevas aplican esas reglas. No se permiten recolecciones en sábado ni domingo; los festivos se gestionan mediante el procedimiento del almacén.

En **Avisos y prácticas**, redacta avisos generales y activa/desactiva su visibilidad. Las prácticas vinculan una lista sugerida de materiales y cantidades que el alumno puede agregar a su carrito si existe disponibilidad.

En **Reportes**, selecciona préstamos, materiales más solicitados, daños, pérdidas, incidencias o adeudos. Combina fechas, alumno, material, estado y tipo de incidencia. Genera una vista previa o exporta PDF/Excel. **Bitácora** muestra usuario, rol, fecha/hora, acción y módulo; permite filtrar por Usuarios, Préstamos o Materiales e inventario. Sus registros son inmutables y sólo el administrador puede consultarlos.

## Encargado de ventanilla

### Preparar y entregar

La cola se actualiza automáticamente y presenta las solicitudes en orden de registro. Sólo puede prepararse la pendiente más antigua. Selecciona **Preparar** y confirma; el alumno recibe el código de recolección. El límite de recogida es la hora acordada más la tolerancia configurada al preparar. Si el alumno no llega a tiempo, el sistema marca la solicitud como No recogida y libera las piezas; también puedes hacerlo desde el botón habilitado cuando vence la tolerancia. Una solicitud pendiente que no se preparó antes de su hora de recolección más la tolerancia se cancela automáticamente, libera su material y deja de bloquear la cola.

1. Escanea o escribe el **código de solicitud** presentado por el alumno y presiona Enter, o abre **Validar y entregar** en Preparadas.
2. Verifica nombre, matrícula y datos de identificación del alumno; marca la confirmación de identidad.
3. Selecciona fecha y hora de devolución. El máximo es el menor límite de los materiales del préstamo, contado desde la entrega. Si cae en fin de semana, el límite mostrado se ajusta al viernes anterior; selecciona una hora de ese viernes que no lo exceda.
4. Escanea cada pieza física, en cualquier orden, y selecciona obligatoriamente su estado de salida. El lector funciona como teclado y Enter avanza al siguiente campo de código. Puedes entregar cualquier pieza disponible del material solicitado: el sistema reasigna la reserva a la pieza entregada. Cada lectura se valida al momento y muestra el material reconocido.
5. Registra observaciones relevantes y confirma la entrega.

Los códigos de pieza no se muestran en ventanilla; deben leerse de la etiqueta física. Una pieza de otro material, ya reservada o prestada en otra solicitud, duplicada o faltante bloquea la entrega. No puede entregarse una solicitud pendiente sin prepararla ni material dañado o roto. Los materiales sólo pueden usarse dentro de la Facultad de Ciencias Químicas e Ingeniería.

### Devolver y resolver defectos previos

En **En préstamo**, elige **Registrar devolución**. Escanea las piezas devueltas en cualquier orden y registra su condición: Íntegro, Rayado, Astillado, Dañado o Roto. Si falta alguna, el formulario indica qué material quedó sin escanear; marca que no fue devuelta para registrarla como perdida. Cada pieza admite una observación. Confirma los estados antes de guardar.

Si todo regresa íntegro, el préstamo se cierra y las piezas vuelven a disponibilidad. Una pieza con daño nuevo o pérdida genera automáticamente incidencia y adeudo; el préstamo queda Con incidencia y el alumno debe acudir con el administrador para formalizar la reposición. La pieza dañada se separa del inventario disponible sin afectar las demás unidades sanas.

En **Defectos previos**, revisa los reportes del alumno y acepta o rechaza cada uno con una respuesta. Resuelve los reportes pendientes antes de registrar la devolución. Una condición física igual a la observación previa aceptada o a la condición de salida no se atribuye como daño nuevo al alumno. Un daño distinto o una pérdida sí genera incidencia. Todo queda en el historial.

El encargado no tiene acceso a usuarios, inventario administrativo, configuración, reportes ejecutivos ni bitácora. El administrador puede entrar a ventanilla desde su panel.

## Alumno

Busca materiales por nombre, características o categoría. Revisa imagen, unidades disponibles y tiempo máximo. Agrega materiales y cantidades al carrito, selecciona día hábil y hora de recolección y acepta el uso exclusivo dentro del plantel. Envía la solicitud: las piezas quedan reservadas y el pedido entra a la cola.

En **Mis préstamos**, puedes cancelar mientras esté Pendiente. Cuando esté Preparada, muestra su código junto con tu identificación en ventanilla. Si no recoges dentro de tolerancia, la solicitud se cancela automáticamente. Ya recibido el material, puedes reportar un defecto previo indicando pieza, condición y descripción para revisión del encargado.

Consulta en el historial las condiciones físicas, fechas, observaciones e incidencias. **Convenios y adeudos** muestra el estado de cuenta y los plazos de reposición. Una incidencia pendiente requiere convenio; un convenio vigente permite solicitar; un convenio o préstamo vencido restringe nuevas solicitudes. Los avisos y notificaciones muestran preparación, inasistencia, disponibilidad, próximos vencimientos y adeudos. Usa **Avisarme cuando esté disponible** en un material agotado para recibir su aviso.
