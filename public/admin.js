'use strict';
let inventario = [],
  usuarios = [],
  padron = [],
  incidencias = [],
  adeudos = [],
  convenios = [],
  avisosAdmin = [],
  practicasAdmin = [],
  tabAdmin = 'inventario',
  importaciones = {},
  credenciales = [];
if (requerirSesion({ roles: ['ADMIN'] })) iniciarAdmin().catch((e) => mensaje(e.message, 'error'));
async function iniciarAdmin() {
  pestañas();
  await reglas();
  await cargarAdmin(true);
  await cargarConfig();
  document.addEventListener('cima:tab', (ev) => {
    tabAdmin = ev.detail;
    cargarAdmin(false).catch((e) => mensaje(e.message, 'error'));
    if (tabAdmin === 'actividad') cargarActividad().catch((e) => mensaje(e.message, 'error'));
  });
  polling(() => cargarAdmin(false));
  $('inventario-buscar').oninput = dibujarInventario;
  $('inventario-estado').onchange = dibujarInventario;
  $('usuarios-buscar').oninput = dibujarUsuarios;
  $('usuarios-rol').onchange = dibujarUsuarios;
  $('incidencia-tipo').onchange = dibujarIncidencias;
  $('incidencia-estado').onchange = dibujarIncidencias;
  $('nuevo-material').onclick = () => editarMaterial();
  $('nuevo-encargado').onclick = crearEncargado;
  $('nuevo-aviso').onclick = () => editarAviso();
  $('nueva-practica').onclick = () => editarPractica();
  document.body.addEventListener('click', accionesAdmin);
  for (const tipo of ['alumnos', 'materiales']) {
    $(`import-${tipo}`).onsubmit = (ev) => prepararImportacion(ev, tipo);
    $(`archivo-${tipo}`).onchange = () => invalidarImportacion(tipo);
    $(`confirmar-${tipo}`).onclick = () => confirmarImportacion(tipo);
  }
  $('semestre-completo').onchange = () => invalidarImportacion('alumnos');
  $('descargar-credenciales').onclick = () =>
    archivoTexto('credenciales-cima.csv', aCSV(['matricula', 'correo', 'password'], credenciales));
  $('ocultar-credenciales').onclick = () => {
    credenciales = [];
    $('credenciales-texto').textContent = '';
    $('credenciales').hidden = true;
  };
  $('config-form').onsubmit = guardarConfig;
  $('reporte-form').onsubmit = (ev) => {
    ev.preventDefault();
    generarReporte().catch((e) => mensaje(e.message, 'error'));
  };
  $('actividad-form').onsubmit = (ev) => {
    ev.preventDefault();
    cargarActividad().catch((e) => mensaje(e.message, 'error'));
  };
}
async function cargarAdmin(inicial = false) {
  const trabajos = [
    ['materiales', (v) => (inventario = lista(v))],
    ['incidencias', (v) => (incidencias = lista(v))],
    ['convenios', (v) => (convenios = lista(v))],
  ];
  if (inicial || tabAdmin === 'usuarios')
    trabajos.push(
      ['usuarios', (v) => (usuarios = lista(v))],
      ['padron', (v) => (padron = lista(v))],
    );
  if (inicial || tabAdmin === 'incidencias')
    trabajos.push(['adeudos', (v) => (adeudos = lista(v))]);
  if (inicial || tabAdmin === 'avisos')
    trabajos.push(
      ['avisos', (v) => (avisosAdmin = lista(v))],
      ['practicas', (v) => (practicasAdmin = lista(v))],
    );
  await Promise.all(
    trabajos.map(async ([url, guardar]) => guardar(await api(`/api/admin/${url}`))),
  );
  $('stat-materiales').textContent = inventario.filter((m) => m.estado !== 'BAJA').length;
  $('stat-piezas').textContent = inventario.reduce(
    (n, m) =>
      n + (m.piezas || []).filter((p) => p.estado === 'DISPONIBLE' && m.estado === 'ACTIVO').length,
    0,
  );
  $('stat-incidencias').textContent = incidencias.filter((x) => x.estado !== 'LIQUIDADA').length;
  $('stat-convenios').textContent = convenios.filter((x) => x.estado === 'ACTIVO').length;
  if (inicial || tabAdmin === 'inventario') dibujarInventario();
  if (inicial || tabAdmin === 'usuarios') {
    dibujarUsuarios();
    dibujarPadron();
  }
  if (inicial || tabAdmin === 'incidencias') {
    dibujarIncidencias();
    dibujarAdeudos();
    dibujarConvenios();
  }
  if (inicial || tabAdmin === 'avisos') {
    dibujarAvisos();
    dibujarPracticasAdmin();
  }
  actualizarSelectReportes();
}
function dibujarInventario() {
  const q = $('inventario-buscar').value.toLocaleLowerCase('es'),
    estado = $('inventario-estado').value;
  const rows = inventario.filter(
    (m) =>
      (!estado || m.estado === estado) &&
      `${m.nombre} ${m.categoria}`.toLocaleLowerCase('es').includes(q),
  );
  $('inventario').innerHTML =
    rows
      .map(
        (m) =>
          `<tr><td><strong>${esc(m.nombre)}</strong><small>${esc(m.categoria)}</small><small>${esc(m.caracteristicas)}</small></td><td>${badge(m.estado)}</td><td>${(m.piezas || []).filter((x) => x.estado === 'DISPONIBLE' && m.estado === 'ACTIVO').length} disponibles<small>${m.cantidadTotal} en inventario</small></td><td>${m.maxHoras} horas</td><td><div class="actions"><button class="mini sec" data-editar-material="${m.id}">Editar</button><button class="mini sec" data-piezas="${m.id}">Piezas y códigos</button>${m.estado !== 'BAJA' ? `<button class="mini sec" data-baja="${m.id}">Dar de baja</button>` : ''}</div></td></tr>`,
      )
      .join('') || tablaVacia(5, 'No se encontraron materiales.');
}
function dibujarUsuarios() {
  const q = $('usuarios-buscar').value.toLocaleLowerCase('es'),
    rol = $('usuarios-rol').value;
  const rows = usuarios.filter(
    (u) =>
      (!rol || u.rol === rol) &&
      `${u.nombre} ${u.matricula} ${u.correo}`.toLocaleLowerCase('es').includes(q),
  );
  $('usuarios').innerHTML =
    rows
      .map(
        (u) =>
          `<tr><td><strong>${esc(u.nombre)}</strong><small>${esc(u.carrera || '')} ${esc(u.periodo || '')}</small></td><td>${esc(u.matricula)}<small>${esc(u.correo)}</small></td><td>${esc(etiqueta(u.rol))}</td><td>${badge(u.activo ? 'ACTIVO' : 'INACTIVO')}${u.bloqueo ? '<small>Bloqueo administrativo</small>' : ''}${u.debeCambiarPassword ? '<small>Contraseña temporal</small>' : ''}</td><td><button class="mini sec" data-editar-usuario="${u.id}">Editar cuenta</button></td></tr>`,
      )
      .join('') || tablaVacia(5);
}
function dibujarPadron() {
  $('padron').innerHTML =
    padron
      .map(
        (u) =>
          `<tr><td>${esc(u.matricula)}</td><td>${esc(u.nombre)}<small>${esc(u.correo || '')}</small></td><td>${esc(u.carrera || '')}</td><td>${esc(u.periodo || '')}</td><td>${badge(u.activo ? 'ACTIVO' : 'INACTIVO')}</td></tr>`,
      )
      .join('') || tablaVacia(5, 'No hay registros en el padrón.');
}
function dibujarIncidencias() {
  const tipo = $('incidencia-tipo').value,
    estado = $('incidencia-estado').value;
  const rows = incidencias.filter(
    (i) => (!tipo || i.tipo === tipo) && (!estado || i.estado === estado),
  );
  $('incidencias').innerHTML =
    rows
      .map(
        (i) =>
          `<tr><td><strong>#${i.id} · ${esc(etiqueta(i.tipo))}</strong><small>${fecha(i.creadoEn)}</small><small>Préstamo #${i.prestamoId}</small></td><td>${esc(i.usuario?.nombre)}<small>${esc(i.usuario?.matricula)}</small></td><td>${esc(i.piezaPrestamo?.pieza?.material?.nombre)}<small class="code">${esc(i.piezaPrestamo?.pieza?.codigo)}</small></td><td>${esc(i.descripcion)}<small>Registró: ${esc(i.encargado?.nombre || `Encargado #${i.encargadoId}`)}</small></td><td>${badge(i.estado)}</td><td><button class="mini sec" data-comprobante="${i.id}">Comprobante</button></td></tr>`,
      )
      .join('') || tablaVacia(6);
}
function dibujarAdeudos() {
  $('adeudos').innerHTML =
    adeudos
      .map(
        (a) =>
          `<tr><td><strong>#${a.id}</strong><small>${fecha(a.creadoEn)}</small></td><td>${esc(a.usuario?.nombre)}<small>${esc(a.usuario?.matricula)}</small></td><td>${esc(a.incidencia?.descripcion)}<small>Incidencia #${a.incidenciaId}</small></td><td>${badge(a.estado)}</td><td><div class="actions">${a.estado !== 'LIQUIDADO' ? `${a.estado !== 'CONVENIO' ? `<button class="mini" data-crear-convenio="${a.id}">Crear convenio</button>` : ''}<button class="mini sec" data-liquidar-adeudo="${a.id}">Liquidar adeudo</button>` : '—'}</div></td></tr>`,
      )
      .join('') || tablaVacia(5, 'No hay adeudos registrados.');
}
function dibujarConvenios() {
  $('convenios').innerHTML =
    convenios
      .map(
        (c) =>
          `<tr><td><strong>#${c.id}</strong><small>Creado: ${fecha(c.fechaCreacion)}</small></td><td>${esc(c.usuario?.nombre)}<small>${esc(c.usuario?.matricula)}</small></td><td>${esc(c.adeudo?.incidencia?.piezaPrestamo?.pieza?.material?.nombre)}<small>${esc(c.descripcion)}</small>${c.comprobante ? `<small>Comprobante: ${esc(c.comprobante)}</small>` : ''}</td><td>${fecha(c.fechaLimite)}</td><td>${badge(c.estado)}</td><td>${c.estado !== 'LIQUIDADO' ? `<button class="mini sec" data-liquidar-convenio="${c.id}">Registrar reposición / Liquidar</button>` : '—'}</td></tr>`,
      )
      .join('') || tablaVacia(6, 'No hay convenios registrados.');
}
function dibujarAvisos() {
  $('avisos-lista').innerHTML =
    avisosAdmin
      .map(
        (a) =>
          `<article class="loan-card"><div class="section-head"><strong>${esc(a.titulo)}</strong>${badge(a.activo ? 'ACTIVO' : 'INACTIVO')}</div><p>${esc(a.contenido)}</p><p class="small muted">${fecha(a.creadoEn)}</p><div class="actions"><button class="mini sec" data-editar-aviso="${a.id}">Editar</button><button class="mini sec" data-toggle-aviso="${a.id}">${a.activo ? 'Desactivar' : 'Activar'}</button></div></article>`,
      )
      .join('') || '<p class="empty">No hay avisos publicados.</p>';
}
function dibujarPracticasAdmin() {
  $('practicas-lista').innerHTML =
    practicasAdmin
      .map(
        (p) =>
          `<article class="loan-card"><div class="section-head"><strong>${esc(p.nombre)}</strong><button class="mini sec" data-editar-practica="${p.id}">Editar</button></div><p class="small">${esc(p.descripcion)}</p><p class="small muted">${(
            p.materiales || []
          )
            .map(
              (x) =>
                `${x.cantidad} × ${inventario.find((m) => m.id === x.materialId)?.nombre || 'Material retirado'}`,
            )
            .map(esc)
            .join(', ')}</p></article>`,
      )
      .join('') || '<p class="empty">No hay prácticas configuradas.</p>';
}
function campo(name, label, value = '', options = {}) {
  const type = options.type || 'text';
  return `<div${options.full ? ' class="full"' : ''}><label for="f-${name}">${esc(label)}</label>${options.area ? `<textarea id="f-${name}" name="${name}" maxlength="${options.max || 3000}" ${options.required === false ? '' : 'required'}>${esc(value)}</textarea>` : `<input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${options.required === false ? '' : 'required'} ${type === 'number' ? `min="${options.min ?? 0}" max="${options.max || 10000}"` : ''} ${type === 'password' ? 'minlength="8" maxlength="72" autocomplete="new-password"' : `maxlength="${options.max || 3000}"`}>`}</div>`;
}
function editarMaterial(m) {
  modal(
    m ? 'Editar material' : 'Nuevo material',
    `<div class="form-grid">${campo('nombre', 'Nombre', m?.nombre || '', { max: 150 })}${campo('categoria', 'Categoría', m?.categoria || '', { max: 100 })}${campo('caracteristicas', 'Características técnicas', m?.caracteristicas || '', { area: true, full: true })}${campo('fotografia', 'Fotografía (URL HTTPS o ruta local)', m?.fotografia || '', { required: false, full: true, max: 500000 })}${campo('cantidadTotal', 'Unidades en inventario', m?.cantidadTotal ?? 1, { type: 'number', min: 0 })}${campo('maxHoras', 'Tiempo máximo de préstamo (horas)', m?.maxHoras || 24, { type: 'number', min: 1, max: 8760 })}<div class="full"><label for="f-estado">Estado del catálogo</label><select id="f-estado" name="estado">${['ACTIVO', 'MANTENIMIENTO', 'BAJA'].map((e) => `<option value="${e}" ${m?.estado === e ? 'selected' : ''}>${etiqueta(e)}</option>`).join('')}</select></div></div><p class="small muted" style="margin-top:14px">Al reducir unidades se dan de baja únicamente piezas disponibles. Las piezas dañadas requieren revisión individual antes de volver al stock.</p>`,
    async (d) => {
      const body = { ...d, cantidadTotal: Number(d.cantidadTotal), maxHoras: Number(d.maxHoras) };
      if (
        body.estado === 'BAJA' &&
        !confirm('¿Dar de baja este material? Se conservará su historial.')
      )
        throw new Error('La baja requiere confirmación.');
      await api(m ? `/api/admin/materiales/${m.id}` : '/api/admin/materiales', {
        method: m ? 'PATCH' : 'POST',
        body,
      });
      await cargarAdmin();
      mensaje('Material guardado.');
    },
  );
}
function verPiezas(m) {
  const d = modal(
    `Piezas y códigos · ${m.nombre}`,
    `<p class="small muted">Conserva estos códigos en las etiquetas físicas. El encargado puede escanearlos o ingresarlos con el teclado.</p><div class="actions" style="margin-bottom:14px"><button class="sec mini" type="button" id="imprimir-piezas">Imprimir códigos</button></div><div class="table-wrap"><table><thead><tr><th>Código único</th><th>Estado</th><th>Condición</th><th></th></tr></thead><tbody>${(m.piezas || []).map((p) => `<tr><td class="code">${esc(p.codigo)}</td><td>${badge(p.estado)}</td><td>${esc(etiqueta(p.condicion))}</td><td><button type="button" class="mini sec" data-editar-pieza="${p.id}" data-material="${m.id}" ${['RESERVADA', 'PRESTADA'].includes(p.estado) ? 'disabled' : ''}>Revisar</button></td></tr>`).join('') || tablaVacia(4)}</tbody></table></div>`,
    async () => {},
    'Cerrar',
  );
  d.querySelector('#imprimir-piezas').onclick = () => window.print();
}
function editarPieza(m, p) {
  modal(
    `Revisar pieza ${p.codigo}`,
    `<p>${esc(m.nombre)}</p><label for="pieza-estado">Estado final</label><select id="pieza-estado" name="estado">${['DISPONIBLE', 'MANTENIMIENTO', 'BAJA', 'PERDIDA'].map((e) => `<option value="${e}" ${p.estado === e ? 'selected' : ''}>${etiqueta(e)}</option>`).join('')}</select><label for="pieza-condicion">Condición física</label><select id="pieza-condicion" name="condicion">${condiciones(p.condicion, true)}</select><p class="small muted" style="margin-top:14px">Para liberar una pieza a disponible, el catálogo debe estar activo y la condición debe permitir su uso.</p>`,
    async (d) => {
      if (!confirm(`¿Confirmar el nuevo estado de la pieza ${p.codigo}?`))
        throw new Error('El cambio requiere confirmación.');
      await api(`/api/admin/piezas/${p.id}`, { method: 'PATCH', body: d });
      await cargarAdmin();
      mensaje('Revisión de pieza registrada.');
    },
  );
}
function crearEncargado() {
  modal(
    'Crear cuenta de ventanilla',
    `<div class="form-grid">${campo('nombre', 'Nombre completo', '', { full: true, max: 200 })}${campo('correo', 'Correo de acceso', '', { type: 'email', full: true, max: 254 })}${campo('password', 'Contraseña inicial', '', { type: 'password', full: true })}</div><p class="small muted" style="margin-top:14px">El encargado podrá gestionar solicitudes, entregas y devoluciones.</p>`,
    async (d) => {
      await api('/api/admin/usuarios', { method: 'POST', body: { ...d, rol: 'ENCARGADO' } });
      await cargarAdmin();
      mensaje('Cuenta de ventanilla creada.');
    },
  );
}
function editarUsuario(u) {
  modal(
    `Editar cuenta · ${u.nombre}`,
    `<div class="form-grid">${campo('nombre', 'Nombre completo', u.nombre, { full: true, max: 200 })}${campo('correo', 'Correo', u.correo, { type: 'email', full: true, max: 254 })}${['ALUMNO', 'DOCENTE'].includes(u.rol) ? campo('carrera', 'Carrera', u.carrera || '', { required: false }) + campo('periodo', 'Periodo o grupo', u.periodo || '', { required: false }) : ''}${campo('fotografia', 'Fotografía de identificación (URL HTTPS)', u.fotografia || '', { required: false, full: true, max: 500000 })}${campo('password', 'Nueva contraseña temporal (opcional)', '', { type: 'password', required: false, full: true })}</div><label class="check"><input name="activo" type="checkbox" ${u.activo ? 'checked' : ''}><span>Cuenta activa</span></label><label class="check"><input name="bloqueo" type="checkbox" ${u.bloqueo ? 'checked' : ''}><span>Bloquear nuevas solicitudes por decisión administrativa</span></label>`,
    async (d, form) => {
      const body = {
        ...d,
        activo: form.elements.activo.checked,
        bloqueo: form.elements.bloqueo.checked,
      };
      if (!body.password) delete body.password;
      if (
        !confirm(
          '¿Guardar los cambios de esta cuenta? Los cambios de acceso cerrarán sus sesiones vigentes.',
        )
      )
        throw new Error('El cambio requiere confirmación.');
      await api(`/api/admin/usuarios/${u.id}`, { method: 'PATCH', body });
      await cargarAdmin();
      mensaje('Cuenta actualizada.');
    },
  );
}
function crearConvenio(a) {
  modal(
    `Convenio para adeudo #${a.id}`,
    `<div class="notice"><strong>${esc(a.usuario?.nombre)}</strong><p>${esc(a.incidencia?.descripcion)}</p></div>${campo('descripcion', 'Acuerdo de reposición', '', { area: true })}${campo('fechaLimite', 'Fecha y hora límite de reposición', '', { type: 'datetime-local' })}<p class="small muted" style="margin-top:14px">Mientras el convenio esté vigente, el alumno podrá seguir solicitando material.</p>`,
    async (d) => {
      if (!confirm('¿Formalizar este convenio de reposición?'))
        throw new Error('El convenio requiere confirmación.');
      await api('/api/admin/convenios', {
        method: 'POST',
        body: {
          adeudoId: a.id,
          descripcion: d.descripcion,
          fechaLimite: desdeLocal(d.fechaLimite),
        },
      });
      await cargarAdmin();
      mensaje('Convenio de reposición registrado.');
    },
    'Formalizar convenio',
  );
}
function liquidar(tipo, id) {
  modal(
    `Liquidar ${tipo === 'convenios' ? 'convenio' : 'adeudo'} #${id}`,
    `${campo('comprobante', 'Referencia del comprobante o reposición', '', { max: 2000 })}${campo('notas', 'Observaciones administrativas', '', { area: true, required: false, max: 2000 })}<p class="small muted" style="margin-top:14px">Confirma que la reposición o el comprobante fue recibido por el procedimiento del almacén.</p>`,
    async (d) => {
      if (
        !confirm(
          '¿Confirmar la liquidación administrativa? El acuerdo y la incidencia asociados se actualizarán en el historial.',
        )
      )
        throw new Error('La liquidación requiere confirmación.');
      await api(`/api/admin/${tipo}/${id}/liquidar`, { method: 'POST', body: d });
      await cargarAdmin();
      mensaje('Liquidación registrada y estado del alumno actualizado.');
    },
    'Confirmar liquidación',
  );
}
function invalidarImportacion(tipo) {
  delete importaciones[tipo];
  $(`confirmar-${tipo}`).hidden = true;
  $(`preview-${tipo}`).innerHTML = '';
}
async function leerArchivo(file) {
  if (file.size > 6 * 1024 * 1024) throw new Error('El archivo no debe exceder 6 MB.');
  if (/\.csv$/i.test(file.name)) return { formato: 'csv', contenido: await file.text() };
  if (/\.xlsx$/i.test(file.name)) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    let raw = '';
    for (let i = 0; i < buffer.length; i += 8192)
      raw += String.fromCharCode(...buffer.subarray(i, i + 8192));
    return { formato: 'xlsx', contenido: btoa(raw) };
  }
  throw new Error('Selecciona un archivo CSV o Excel XLSX.');
}
async function prepararImportacion(ev, tipo) {
  ev.preventDefault();
  const b = ev.target.querySelector('[type=submit]');
  b.disabled = true;
  invalidarImportacion(tipo);
  try {
    const file = $(`archivo-${tipo}`).files[0];
    if (!file) throw new Error('Selecciona un archivo.');
    const body = {
      ...(await leerArchivo(file)),
      confirmar: false,
      ...(tipo === 'alumnos' ? { semestreCompleto: $('semestre-completo').checked } : {}),
    };
    const r = await api(`/api/admin/importar/${tipo}`, { method: 'POST', body });
    importaciones[tipo] = { body, preflight: r };
    dibujarImportacion(tipo, r);
    $(`confirmar-${tipo}`).hidden = !r.valido;
    mensaje(
      r.valido
        ? 'Archivo válido. Revisa el resumen y confirma la importación.'
        : 'Revisa los errores antes de importar.',
      r.valido ? 'ok' : 'error',
    );
  } catch (e) {
    const r = e.data;
    if (r?.errores) {
      dibujarImportacion(tipo, r);
    }
    mensaje(e.message, 'error');
  } finally {
    b.disabled = false;
  }
}
function dibujarImportacion(tipo, r) {
  const resumen = r.resumen || {};
  $(`preview-${tipo}`).innerHTML =
    `<div class="notice" style="margin-top:15px"><strong>${r.valido ? 'Validación correcta' : 'Se encontraron errores'}</strong><p class="small">${Object.entries(
      resumen,
    )
      .map(([k, v]) => `${esc(k)}: ${esc(v)}`)
      .join(
        ' · ',
      )}</p></div>${(r.errores || []).length ? `<div class="table-wrap"><table><thead><tr><th>Fila</th><th>Error</th></tr></thead><tbody>${r.errores.map((e) => `<tr><td>${esc(e.fila)}</td><td>${esc(e.error || e.mensaje)}</td></tr>`).join('')}</tbody></table></div>` : ''}${(r.registros || []).length ? `<details class="subform"><summary>Vista previa de ${r.registros.length} registro(s)</summary><pre class="small" style="white-space:pre-wrap">${esc(JSON.stringify(r.registros.slice(0, 10), null, 2))}${r.registros.length > 10 ? '\nSolo se muestran los primeros 10 registros.' : ''}</pre></details>` : ''}`;
}
async function confirmarImportacion(tipo) {
  const entrada = importaciones[tipo];
  if (!entrada?.preflight.valido) return;
  if (
    !confirm(
      tipo === 'alumnos' && entrada.body.semestreCompleto
        ? '¿Importar la lista completa e inactivar a los alumnos ausentes? Se conservará su historial.'
        : `¿Aplicar la importación de ${tipo}?`,
    )
  )
    return;
  const b = $(`confirmar-${tipo}`);
  b.disabled = true;
  try {
    const r = await api(`/api/admin/importar/${tipo}`, {
      method: 'POST',
      body: { ...entrada.body, confirmar: true },
    });
    dibujarImportacion(tipo, r);
    if (!r.valido) {
      b.hidden = true;
      delete importaciones[tipo];
      mensaje(
        'La información cambió desde la validación. Revisa los errores y valida el archivo nuevamente.',
        'error',
      );
      return;
    }
    b.hidden = true;
    delete importaciones[tipo];
    if (tipo === 'alumnos' && r.credenciales?.length) {
      credenciales = r.credenciales;
      $('credenciales').hidden = false;
      $('credenciales-texto').textContent = credenciales
        .map((c) => `${c.matricula} · ${c.correo}\nContraseña: ${c.password}`)
        .join('\n\n');
    }
    await cargarAdmin();
    mensaje('Importación completada. Revisa el resumen de resultados.');
  } catch (e) {
    if (e.data?.errores) dibujarImportacion(tipo, e.data);
    mensaje(e.message, 'error');
  } finally {
    b.disabled = false;
  }
}
function archivoTexto(nombre, contenido) {
  const url = URL.createObjectURL(
    new Blob(['\ufeff', contenido], { type: 'text/csv;charset=utf-8' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function aCSV(columnas, filas) {
  const celda = (v) =>
    '"' +
    String(v ?? '')
      .replace(/^[=+@-]/, "'$&")
      .replace(/"/g, '""') +
    '"';
  return [
    columnas.map(celda).join(','),
    ...filas.map((f) => columnas.map((k) => celda(f[k])).join(',')),
  ].join('\r\n');
}
function plantilla(tipo) {
  if (tipo === 'alumnos')
    archivoTexto('plantilla-alumnos.csv', 'matricula,nombre,correo,carrera,periodo,estado\r\n');
  else
    archivoTexto(
      'plantilla-inventario.csv',
      'nombre,categoria,caracteristicas,cantidad,maxHoras,fotografia\r\n',
    );
}
async function cargarConfig() {
  const c = await api('/api/admin/configuracion');
  for (const el of $('config-form').elements)
    if (el.name && c[el.name] !== undefined) el.value = c[el.name];
}
async function guardarConfig(ev) {
  ev.preventDefault();
  const b = ev.target.querySelector('[type=submit]');
  b.disabled = true;
  try {
    const body = serializeForm(ev.target);
    for (const k of [
      'toleranciaMinutos',
      'anticipacionMaxHoras',
      'anticipacionMinMinutos',
      'avisoVencimientoMinutos',
    ])
      body[k] = Number(body[k]);
    await api('/api/admin/configuracion', { method: 'PATCH', body });
    mensaje('Reglas guardadas para las nuevas solicitudes.');
  } catch (e) {
    mensaje(e.message, 'error');
  } finally {
    b.disabled = false;
  }
}
function actualizarSelectReportes() {
  for (const [id, rows, label] of [
    ['reporte-material', inventario, (x) => x.nombre],
    [
      'reporte-usuario',
      usuarios.filter((u) => ['ALUMNO', 'DOCENTE'].includes(u.rol)),
      (x) => `${x.nombre} · ${x.matricula}`,
    ],
  ]) {
    const el = $(id),
      value = el.value;
    const html =
      `<option value="">${id === 'reporte-material' ? 'Todos los materiales' : 'Todos los alumnos'}</option>` +
      rows.map((x) => `<option value="${x.id}">${esc(label(x))}</option>`).join('');
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      el.value = value;
    }
  }
}
function filtrosReporte() {
  const d = Object.fromEntries(new FormData($('reporte-form')));
  for (const k of Object.keys(d)) if (!d[k]) delete d[k];
  if (d.estado) d.estado = d.estado.trim().toUpperCase();
  return new URLSearchParams(d);
}
async function generarReporte() {
  const params = filtrosReporte();
  params.set('formato', 'json');
  const r = await api(`/api/admin/reportes?${params}`);
  const filas = lista(r.filas),
    columnas = r.columnas || Object.keys(filas[0] || {});
  $('reporte-resumen').textContent = `${r.total ?? filas.length} registro(s). ${
    r.estadisticas
      ? Object.entries(r.estadisticas)
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
          .join(' · ')
      : ''
  }`;
  $('reporte-preview').innerHTML =
    `<div class="table-wrap"><table><thead><tr>${columnas.map((c) => `<th>${esc(typeof c === 'object' ? c.titulo || c.label || c.key : c)}</th>`).join('')}</tr></thead><tbody>${
      filas
        .map(
          (f) =>
            `<tr>${columnas
              .map((c) => {
                const v = f[typeof c === 'object' ? c.key : c];
                return `<td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td>`;
              })
              .join('')}</tr>`,
        )
        .join('') || tablaVacia(Math.max(columnas.length, 1), 'No hay registros con estos filtros.')
    }</tbody></table></div>`;
}
async function cargarActividad() {
  const params = new URLSearchParams([...new FormData($('actividad-form'))].filter(([, v]) => v));
  const rows = lista(await api(`/api/admin/actividad?${params}`));
  $('actividad').innerHTML =
    rows
      .map(
        (a) =>
          `<tr><td class="nowrap">${fecha(a.fecha)}</td><td>${esc(a.nombre)}<small>${esc(etiqueta(a.rol))}</small></td><td>${esc(a.modulo)}</td><td>${esc(a.accion)}</td><td class="small">${esc(a.detalle ? JSON.stringify(a.detalle) : '—')}</td></tr>`,
      )
      .join('') || tablaVacia(5, 'No hay actividad con esos filtros.');
}
function editarAviso(a) {
  modal(
    a ? 'Editar aviso' : 'Publicar aviso',
    `${campo('titulo', 'Título', a?.titulo || '', { max: 180 })}${campo('contenido', 'Contenido', a?.contenido || '', { area: true, max: 5000 })}<label class="check"><input name="activo" type="checkbox" ${!a || a.activo ? 'checked' : ''}><span>Mostrar este aviso a los alumnos activos</span></label>`,
    async (d, form) => {
      await api(a ? `/api/admin/avisos/${a.id}` : '/api/admin/avisos', {
        method: a ? 'PATCH' : 'POST',
        body: { ...d, activo: form.elements.activo.checked },
      });
      await cargarAdmin();
      mensaje('Aviso guardado.');
    },
  );
}
function editarPractica(p) {
  const contenido =
    campo('nombre', 'Nombre de la práctica', p?.nombre || '', { max: 150 }) +
    campo('descripcion', 'Descripción', p?.descripcion || '', { area: true, required: false }) +
    '<h3 style="margin-top:17px">Cantidades sugeridas</h3><p class="small muted">Deja en cero los materiales que no forman parte de la práctica.</p><div class="table-wrap"><table><thead><tr><th>Material</th><th>Cantidad</th></tr></thead><tbody>' +
    inventario
      .filter((m) => m.estado !== 'BAJA')
      .map(
        (m) =>
          `<tr><td>${esc(m.nombre)}</td><td><input aria-label="Cantidad de ${esc(m.nombre)}" name="material-${m.id}" type="number" min="0" max="10000" value="${p?.materiales?.find((x) => x.materialId === m.id)?.cantidad || 0}"></td></tr>`,
      )
      .join('') +
    '</tbody></table></div>';
  modal(p ? 'Editar práctica' : 'Agregar práctica', contenido, async (d) => {
    const materiales = Object.entries(d)
      .filter(([k, v]) => k.startsWith('material-') && Number(v) > 0)
      .map(([k, v]) => ({ materialId: Number(k.slice(9)), cantidad: Number(v) }));
    if (!materiales.length) throw new Error('Selecciona al menos un material para esta práctica.');
    await api(p ? `/api/admin/practicas/${p.id}` : '/api/admin/practicas', {
      method: p ? 'PATCH' : 'POST',
      body: { nombre: d.nombre, descripcion: d.descripcion, materiales },
    });
    await cargarAdmin();
    mensaje('Práctica guardada.');
  });
}
async function accionesAdmin(event) {
  const b = event.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.editarMaterial) {
      editarMaterial(inventario.find((m) => m.id === Number(b.dataset.editarMaterial)));
    } else if (b.dataset.piezas) {
      verPiezas(inventario.find((m) => m.id === Number(b.dataset.piezas)));
    } else if (b.dataset.editarPieza) {
      const m = inventario.find((m) => m.id === Number(b.dataset.material));
      editarPieza(
        m,
        m.piezas.find((p) => p.id === Number(b.dataset.editarPieza)),
      );
    } else if (b.dataset.baja) {
      if (
        !confirm(
          '¿Dar de baja este material? Se conservará todo el historial. No puede tener piezas reservadas o en préstamo.',
        )
      )
        return;
      b.disabled = true;
      await api(`/api/admin/materiales/${b.dataset.baja}/baja`, { method: 'POST' });
      await cargarAdmin();
      mensaje('Material dado de baja.');
    } else if (b.dataset.editarUsuario) {
      editarUsuario(usuarios.find((u) => u.id === Number(b.dataset.editarUsuario)));
    } else if (b.dataset.crearConvenio) {
      crearConvenio(adeudos.find((a) => a.id === Number(b.dataset.crearConvenio)));
    } else if (b.dataset.liquidarAdeudo) {
      liquidar('adeudos', b.dataset.liquidarAdeudo);
    } else if (b.dataset.liquidarConvenio) {
      liquidar('convenios', b.dataset.liquidarConvenio);
    } else if (b.dataset.comprobante) {
      await descargar(
        `/api/incidencias/${b.dataset.comprobante}/comprobante`,
        `incidencia-${b.dataset.comprobante}.html`,
        true,
      );
    } else if (b.dataset.plantilla) {
      plantilla(b.dataset.plantilla);
    } else if (b.dataset.exportar) {
      b.disabled = true;
      const params = filtrosReporte();
      params.set('formato', b.dataset.exportar);
      await descargar(
        `/api/admin/reportes?${params}`,
        `cima-${params.get('tipo')}.${b.dataset.exportar}`,
      );
    } else if (b.dataset.editarAviso) {
      editarAviso(avisosAdmin.find((a) => a.id === Number(b.dataset.editarAviso)));
    } else if (b.dataset.toggleAviso) {
      const a = avisosAdmin.find((a) => a.id === Number(b.dataset.toggleAviso));
      await api(`/api/admin/avisos/${a.id}`, { method: 'PATCH', body: { activo: !a.activo } });
      await cargarAdmin();
      mensaje('Estado del aviso actualizado.');
    } else if (b.dataset.editarPractica) {
      editarPractica(practicasAdmin.find((p) => p.id === Number(b.dataset.editarPractica)));
    }
  } catch (e) {
    mensaje(e.message, 'error');
  } finally {
    if (b.dataset.baja || b.dataset.exportar) b.disabled = false;
  }
}
