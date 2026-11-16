'use strict';
let cola = [],
  reglasOperacion = {};
if (requerirSesion({ roles: ['ADMIN', 'ENCARGADO'] }))
  iniciarOperacion().catch((e) => mensaje(e.message, 'error'));
async function iniciarOperacion() {
  pestañas();
  reglasOperacion = (await reglas()).configuracion || {};
  await cargarOperacion();
  polling(cargarOperacion);
  $('historial-buscar').oninput = dibujarHistorial;
  $('scan-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const b = ev.target.querySelector('button');
    b.disabled = true;
    try {
      const codigo = $('codigo-solicitud').value.trim();
      const p = await api(`/api/operacion/prestamos/codigo/${encodeURIComponent(codigo)}`);
      if (p.estado === 'PREPARADA') formularioMovimiento(p, 'entregar', codigo);
      else if (p.estado === 'ENTREGADO') formularioMovimiento(p, 'devolver', codigo);
      else verPrestamo(p);
      $('codigo-solicitud').value = '';
    } catch (e) {
      mensaje(e.message, 'error');
    } finally {
      b.disabled = false;
    }
  };
  document.body.addEventListener('click', accionesOperacion);
}
async function cargarOperacion() {
  cola = lista(await api('/api/operacion/prestamos'));
  const pendientes = cola.filter((p) => p.estado === 'PENDIENTE'),
    preparadas = cola.filter((p) => p.estado === 'PREPARADA'),
    entregados = cola.filter((p) => p.estado === 'ENTREGADO');
  $('n-pendientes').textContent = pendientes.length;
  $('n-preparadas').textContent = preparadas.length;
  $('n-entregados').textContent = entregados.length;
  $('n-vencidos').textContent = entregados.filter(
    (p) => p.fechaDevolucion && new Date(p.fechaDevolucion) < new Date(),
  ).length;
  const usuario = (p) =>
    `<strong>${esc(p.usuario?.nombre)}</strong><small>${esc(p.usuario?.matricula)}</small>`;
  $('pendientes').innerHTML =
    pendientes
      .map(
        (p, n) =>
          `<tr><td><strong>${n + 1}. Solicitud #${p.id}</strong><small>${fecha(p.fechaSolicitud)}</small></td><td>${usuario(p)}</td><td>${esc(detallesPrestamo(p))}</td><td>${fecha(p.fechaRecoleccion)}</td><td><div class="actions"><button class="mini" data-preparar="${p.id}" ${n ? 'disabled title="Atiende primero la solicitud anterior"' : ''}>Preparar</button><button class="mini sec" data-ver="${p.id}">Ver</button><button class="mini sec" data-rechazar="${p.id}">Rechazar</button></div></td></tr>`,
      )
      .join('') || tablaVacia(5, 'No hay solicitudes pendientes.');
  $('preparadas').innerHTML =
    preparadas
      .map(
        (p) =>
          `<tr><td><strong>#${p.id}</strong><small class="code">${esc(p.codigo)}</small></td><td>${usuario(p)}</td><td>${esc(detallesPrestamo(p))}</td><td>${fecha(p.limiteRecogida)}</td><td><div class="actions"><button class="mini" data-entregar="${p.id}">Validar y entregar</button><button class="mini sec" data-no-recogido="${p.id}" ${new Date(p.limiteRecogida) > new Date() ? 'disabled' : ''}>No recogida</button></div></td></tr>`,
      )
      .join('') || tablaVacia(5, 'No hay solicitudes preparadas.');
  $('entregados').innerHTML =
    entregados
      .map(
        (p) =>
          `<tr><td><strong>#${p.id}</strong></td><td>${usuario(p)}</td><td>${esc(detallesPrestamo(p))}</td><td>${fecha(p.fechaDevolucion)}${new Date(p.fechaDevolucion) < new Date() ? '<small style="color:var(--red)">Vencido</small>' : ''}</td><td><button class="mini" data-devolver="${p.id}">Registrar devolución</button></td></tr>`,
      )
      .join('') || tablaVacia(5, 'No hay préstamos por devolver.');
  dibujarHistorial();
  dibujarDefectos();
}
function dibujarHistorial() {
  const q = $('historial-buscar').value.toLocaleLowerCase('es');
  const filas = cola.filter((p) =>
    `${p.id} ${p.usuario?.nombre} ${p.usuario?.matricula}`.toLocaleLowerCase('es').includes(q),
  );
  $('historial').innerHTML =
    filas
      .slice()
      .reverse()
      .map(
        (p) =>
          `<tr><td>#${p.id}</td><td>${esc(p.usuario?.nombre)}<small>${esc(p.usuario?.matricula)}</small></td><td>${esc(detallesPrestamo(p))}</td><td>${badge(p.estado)}</td><td>${fecha(p.fechaEntrega)}</td><td>${fecha(p.fechaDevuelto)}</td><td><button class="mini sec" data-ver="${p.id}">Detalle</button></td></tr>`,
      )
      .join('') || tablaVacia(7);
}
function dibujarDefectos() {
  const defectos = cola.flatMap((p) => (p.defectos || []).map((d) => ({ ...d, solicitud: p })));
  $('n-defectos').textContent = defectos.filter((d) => d.estado === 'PENDIENTE').length;
  $('defectos').innerHTML = defectos.length
    ? defectos
        .map((d) => {
          const x = d.solicitud.piezas.find((x) => x.id === d.prestamoPiezaId);
          return `<article class="loan-card"><div class="section-head"><strong>Solicitud #${d.solicitud.id} · ${esc(d.solicitud.usuario?.nombre)}</strong>${badge(d.estado)}</div><p class="small">${esc(x?.pieza?.material?.nombre)} · <span class="code">${esc(x?.pieza?.codigo)}</span> · ${esc(etiqueta(d.condicion))}</p><p>${esc(d.descripcion)}</p><p class="small muted">Enviado: ${fecha(d.creadoEn)}</p>${d.respuesta ? `<p class="small">Respuesta: ${esc(d.respuesta)}</p>` : ''}${d.estado === 'PENDIENTE' ? `<div class="actions"><button class="mini" data-resolver="${d.id}" data-aceptado="true">Aceptar defecto previo</button><button class="mini sec" data-resolver="${d.id}" data-aceptado="false">Rechazar reporte</button></div>` : ''}</article>`;
        })
        .join('')
    : '<p class="empty">No hay reportes de defectos previos.</p>';
}
async function accionesOperacion(event) {
  const b = event.target.closest('button');
  if (!b) return;
  try {
    const id =
      b.dataset.preparar ||
      b.dataset.rechazar ||
      b.dataset.noRecogido ||
      b.dataset.entregar ||
      b.dataset.devolver ||
      b.dataset.ver;
    const p = cola.find((x) => x.id === Number(id));
    if (b.dataset.preparar) {
      if (
        !confirm(
          `¿Preparar la solicitud #${id}? Se notificará al alumno y comenzará su tolerancia de recolección.`,
        )
      )
        return;
      b.disabled = true;
      const r = await api(`/api/operacion/prestamos/${id}/preparar`, { method: 'POST' });
      mensaje(r.mensaje || 'Solicitud preparada.');
      await cargarOperacion();
    } else if (b.dataset.rechazar || b.dataset.noRecogido) {
      const accion = b.dataset.rechazar ? 'rechazar' : 'no-recogido';
      if (
        !confirm(
          `¿${accion === 'rechazar' ? 'Rechazar' : 'Marcar como no recogida'} la solicitud #${id} y liberar sus materiales?`,
        )
      )
        return;
      b.disabled = true;
      await api(`/api/operacion/prestamos/${id}/${accion}`, { method: 'POST' });
      mensaje('Solicitud actualizada y material liberado.');
      await cargarOperacion();
    } else if (b.dataset.entregar || b.dataset.devolver) {
      formularioMovimiento(p, b.dataset.entregar ? 'entregar' : 'devolver');
    } else if (b.dataset.ver) {
      verPrestamo(p);
    } else if (b.dataset.resolver) {
      const aceptado = b.dataset.aceptado === 'true';
      modal(
        aceptado ? 'Aceptar defecto previo' : 'Rechazar defecto previo',
        `<p class="muted">${aceptado ? 'La observación quedará en el historial y ese defecto no se atribuirá al alumno al devolver.' : 'El alumno podrá consultar la respuesta en su historial.'}</p><label for="respuesta-defecto">Observación del encargado</label><textarea name="respuesta" id="respuesta-defecto" required maxlength="2000"></textarea>`,
        async (d) => {
          if (!confirm('¿Confirmar la resolución de este reporte?')) return;
          await api(`/api/operacion/defectos/${b.dataset.resolver}/resolver`, {
            method: 'POST',
            body: { aceptado, respuesta: d.respuesta },
          });
          await cargarOperacion();
          mensaje('Reporte resuelto.');
        },
      );
    } else if (b.dataset.comprobante) {
      await descargar(
        `/api/incidencias/${b.dataset.comprobante}/comprobante`,
        `incidencia-${b.dataset.comprobante}.html`,
        true,
      );
    }
  } catch (e) {
    mensaje(e.message, 'error');
  } finally {
    if (b.dataset.preparar || b.dataset.rechazar || b.dataset.noRecogido) b.disabled = false;
  }
}
function formularioMovimiento(p, accion, codigo = '') {
  if (!p) throw new Error('La solicitud ya no está disponible. Actualiza la cola.');
  const entregar = accion === 'entregar';
  const piezas = p.piezas || [];
  const minimo = Math.min(...piezas.map((x) => x.pieza?.material?.maxHoras || 24));
  const max = p.maxFechaDevolucion || new Date(Date.now() + minimo * 3600000).toISOString();
  const foto =
    typeof p.usuario?.fotografia === 'string' &&
    /^(https?:\/\/|\/|data:image\/(png|jpeg|webp);base64,)/i.test(p.usuario.fotografia)
      ? `<img src="${esc(p.usuario.fotografia)}" alt="Fotografía de ${esc(p.usuario.nombre)}" style="width:80px;height:80px;object-fit:cover;border-radius:9px" referrerpolicy="no-referrer">`
      : '';
  const identidad = `<div class="notice">${foto}<strong>${esc(p.usuario?.nombre)}</strong><p>Matrícula: ${esc(p.usuario?.matricula)}<br>${esc(p.usuario?.correo || '')}</p></div>`;
  const contenido =
    identidad +
    (entregar
      ? `<label for="entrega-codigo">Código de solicitud presentado por el alumno</label><input class="scan-input" id="entrega-codigo" name="codigo" autocomplete="off" value="${esc(codigo)}" required><label class="check"><input name="identidadVerificada" type="checkbox" required><span>Verifiqué la identidad del alumno contra su identificación.</span></label><label for="entrega-fecha">Fecha y hora de devolución</label><input id="entrega-fecha" name="fechaDevolucion" type="datetime-local" min="${inputFecha()}" max="${inputFecha(max)}" required><p class="small muted">Límite más corto: ${minimo} horas. La devolución debe ser un día hábil y no exceder ${fecha(max)}. Si el límite cae en fin de semana, selecciona el viernes anterior.</p>`
      : `<p class="small muted">Escanea cada pieza y registra su estado físico. Para una pérdida, ingresa el código de la pieza faltante y selecciona «Perdido».</p>`) +
    `<h3 style="margin-top:22px">${entregar ? 'Verificación de salida' : 'Revisión de devolución'} · ${piezas.length} pieza(s)</h3>` +
    piezas
      .map(
        (x, n) =>
          `<div class="piece-row" data-piece="${x.id}"><div><strong class="small">${esc(x.pieza?.material?.nombre)}</strong><p class="small muted">Código esperado: <span class="code">${esc(x.pieza?.codigo)}</span></p>${!entregar ? `<p class="small muted">Al entregar: ${esc(etiqueta(x.condicionEntrega))}</p>` : ''}</div><div><label for="piece-code-${n}">Escanear código</label><input class="scan-input piece-code" id="piece-code-${n}" name="codigo-${n}" autocomplete="off" required placeholder="Código de la pieza"></div><div><label for="piece-condition-${n}">Estado físico</label><select id="piece-condition-${n}" name="condicion-${n}" required><option value="">Seleccionar…</option>${condiciones('', !entregar)}</select></div><div class="piece-notes"><label for="piece-notes-${n}">Observación de esta pieza</label><input id="piece-notes-${n}" name="notas-${n}" maxlength="2000" placeholder="Detalles de la revisión física"></div></div>`,
      )
      .join('') +
    (!entregar
      ? '<p class="small muted" style="margin-top:15px">Los daños nuevos y pérdidas generarán una incidencia y un adeudo. Los defectos previos aceptados se conservarán en el historial.</p>'
      : '<p class="small muted" style="margin-top:15px">Todo el material se utilizará exclusivamente dentro del plantel.</p>');
  const d = modal(
    `${entregar ? 'Entregar' : 'Devolver'} · Solicitud #${p.id}`,
    contenido,
    async (data, form) => {
      const codes = [];
      const body = {
        piezas: piezas.map((x, n) => {
          const codigo = data[`codigo-${n}`]?.trim();
          if (codigo !== x.pieza?.codigo)
            throw new Error(`El código de la pieza ${n + 1} no corresponde a esta solicitud.`);
          if (codes.includes(codigo)) throw new Error('No escanees dos veces la misma pieza.');
          codes.push(codigo);
          return { codigo, condicion: data[`condicion-${n}`], notas: data[`notas-${n}`] };
        }),
      };
      if (entregar) {
        if (data.codigo?.trim() !== p.codigo)
          throw new Error('El código de solicitud no corresponde al alumno.');
        if (!form.elements.identidadVerificada.checked)
          throw new Error('Confirma primero la identidad del alumno.');
        if (finDeSemana(data.fechaDevolucion.slice(0, 10)))
          throw new Error('La devolución debe ser de lunes a viernes.');
        body.codigo = data.codigo.trim();
        body.identidadVerificada = true;
        body.fechaDevolucion = desdeLocal(data.fechaDevolucion);
        if (!confirm(`¿Confirmar la entrega de ${piezas.length} pieza(s) a ${p.usuario.nombre}?`))
          throw new Error('Entrega pendiente de confirmación.');
      } else {
        const conDefecto = body.piezas.some((x) => x.condicion !== 'INTEGRO');
        if (
          !confirm(
            conDefecto
              ? '¿Confirmar los estados físicos registrados? Los daños nuevos o pérdidas generarán incidencias y adeudos, y el préstamo quedará con incidencia.'
              : '¿Confirmar la devolución íntegra de todas las piezas y cerrar el préstamo?',
          )
        )
          throw new Error('Devolución pendiente de confirmación.');
        body.confirmarIncidencias = true;
      }
      const r = await api(`/api/operacion/prestamos/${p.id}/${accion}`, { method: 'POST', body });
      await cargarOperacion();
      mensaje(r.mensaje || 'Movimiento registrado.');
      $('codigo-solicitud').focus();
    },
    entregar ? 'Confirmar entrega' : 'Registrar devolución',
  );
  const scans = [...d.querySelectorAll('.scan-input')];
  scans.forEach((input, n) =>
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const next = scans[n + 1];
        if (next) next.focus();
        else input.closest('.piece-row')?.querySelector('select')?.focus();
      }
    }),
  );
  setTimeout(() => scans.find((x) => !x.value)?.focus(), 50);
}
function verPrestamo(p) {
  const d = modal(
    `Solicitud #${p.id}`,
    `<div class="section-head"><strong>${esc(p.usuario?.nombre)} · ${esc(p.usuario?.matricula)}</strong>${badge(p.estado)}</div><p class="small">Solicitud: ${fecha(p.fechaSolicitud)}<br>Recolección: ${fecha(p.fechaRecoleccion)}<br>Entrega: ${fecha(p.fechaEntrega)}<br>Devolver: ${fecha(p.fechaDevolucion)}<br>Devuelto: ${fecha(p.fechaDevuelto)}</p><div class="table-wrap"><table><thead><tr><th>Material / Pieza</th><th>Entrega</th><th>Devolución</th><th>Notas</th></tr></thead><tbody>${(p.piezas || []).map((x) => `<tr><td>${esc(x.pieza?.material?.nombre)}<small class="code">${esc(x.pieza?.codigo)}</small></td><td>${esc(etiqueta(x.condicionEntrega))}</td><td>${esc(etiqueta(x.condicionDevuelto))}</td><td>${esc(x.notasEntrega)} ${esc(x.notasDevuelto)}</td></tr>`).join('') || tablaVacia(4)}</tbody></table></div>${(p.defectos || []).map((x) => `<p class="small" style="margin-top:15px">Defecto previo: ${esc(x.descripcion)} · ${esc(etiqueta(x.estado))} ${esc(x.respuesta)}</p>`).join('')}${(p.incidencias || []).map((i) => `<div class="alerta" style="margin-top:15px">Incidencia #${i.id}: ${esc(i.descripcion)}<div class="actions"><button type="button" class="mini sec" data-comprobante="${i.id}">Ver comprobante</button></div></div>`).join('')}`,
    async () => {},
    'Cerrar',
  );
  d.querySelector('[data-cerrar]').textContent = '×';
}
