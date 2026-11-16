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
          `<tr><td><strong>${n + 1}. Solicitud #${p.id}</strong><small>${fecha(p.fechaSolicitud)}</small></td><td>${usuario(p)}</td><td>${esc(resumenMateriales(p))}</td><td>${fecha(p.fechaRecoleccion)}</td><td><div class="actions"><button class="mini" data-preparar="${p.id}" ${n ? 'disabled title="Atiende primero la solicitud anterior"' : ''}>Preparar</button><button class="mini sec" data-ver="${p.id}">Ver</button><button class="mini sec" data-rechazar="${p.id}">Rechazar</button></div></td></tr>`,
      )
      .join('') || tablaVacia(5, 'No hay solicitudes pendientes.');
  $('preparadas').innerHTML =
    preparadas
      .map(
        (p) =>
          `<tr><td><strong>#${p.id}</strong><small>Código en poder del alumno</small></td><td>${usuario(p)}</td><td>${esc(resumenMateriales(p))}</td><td>${fecha(p.limiteRecogida)}</td><td><div class="actions"><button class="mini" data-entregar="${p.id}">Validar y entregar</button><button class="mini sec" data-no-recogido="${p.id}" ${new Date(p.limiteRecogida) > new Date() ? 'disabled' : ''}>No recogida</button></div></td></tr>`,
      )
      .join('') || tablaVacia(5, 'No hay solicitudes preparadas.');
  $('entregados').innerHTML =
    entregados
      .map(
        (p) =>
          `<tr><td><strong>#${p.id}</strong></td><td>${usuario(p)}</td><td>${esc(resumenMateriales(p))}</td><td>${fecha(p.fechaDevolucion)}${new Date(p.fechaDevolucion) < new Date() ? '<small style="color:var(--red)">Vencido</small>' : ''}</td><td><button class="mini" data-devolver="${p.id}">Registrar devolución</button></td></tr>`,
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
          `<tr><td>#${p.id}</td><td>${esc(p.usuario?.nombre)}<small>${esc(p.usuario?.matricula)}</small></td><td>${esc(resumenMateriales(p))}</td><td>${badge(p.estado)}</td><td>${fecha(p.fechaEntrega)}</td><td>${fecha(p.fechaDevuelto)}</td><td><button class="mini sec" data-ver="${p.id}">Detalle</button></td></tr>`,
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
          return `<article class="loan-card"><div class="section-head"><strong>Solicitud #${d.solicitud.id} · ${esc(d.solicitud.usuario?.nombre)}</strong>${badge(d.estado)}</div><p class="small">${esc(x?.pieza?.material?.nombre)}${d.solicitud.estado === 'ENTREGADO' ? '' : ` · <span class="code">${esc(x?.pieza?.codigo)}</span>`} · ${esc(etiqueta(d.condicion))}</p><p>${esc(d.descripcion)}</p><p class="small muted">Enviado: ${fecha(d.creadoEn)}</p>${d.respuesta ? `<p class="small">Respuesta: ${esc(d.respuesta)}</p>` : ''}${d.estado === 'PENDIENTE' ? `<div class="actions"><button class="mini" data-resolver="${d.id}" data-aceptado="true">Aceptar defecto previo</button><button class="mini sec" data-resolver="${d.id}" data-aceptado="false">Rechazar reporte</button></div>` : ''}</article>`;
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
// Resume los materiales sin revelar los códigos de pieza: en ventanilla se escanea la pieza física.
function resumenMateriales(p) {
  const grupos = new Map();
  for (const x of p.piezas || []) {
    const nombre = x.pieza?.material?.nombre || 'Material';
    grupos.set(nombre, (grupos.get(nombre) || 0) + 1);
  }
  return grupos.size
    ? [...grupos].map(([nombre, cantidad]) => `${nombre} × ${cantidad}`).join(', ')
    : p.material?.nombre || 'Sin piezas';
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
  // Material solicitado y piezas entregadas. Los códigos no se muestran: deben leerse de la pieza.
  const requeridos = new Map();
  for (const x of piezas) {
    const r = requeridos.get(x.pieza?.materialId) || {
      nombre: x.pieza?.material?.nombre || 'Material',
      cantidad: 0,
    };
    r.cantidad++;
    requeridos.set(x.pieza?.materialId, r);
  }
  const entregadas = new Map(piezas.map((x) => [x.pieza?.codigo, x]));
  const lecturas = piezas.map(() => null);
  const ayudaLectura = entregar
    ? 'Escanea una pieza de los materiales solicitados.'
    : 'Escanea una pieza devuelta.';
  const contenido =
    identidad +
    (entregar
      ? `<label for="entrega-codigo">Código de solicitud presentado por el alumno</label><input class="scan-input" id="entrega-codigo" name="codigo" autocomplete="off" value="${esc(codigo)}" required><label class="check"><input name="identidadVerificada" type="checkbox" required><span>Verifiqué la identidad del alumno contra su identificación.</span></label><label for="entrega-fecha">Fecha y hora de devolución</label><input id="entrega-fecha" name="fechaDevolucion" type="datetime-local" min="${inputFecha()}" max="${inputFecha(max)}" required><p class="small muted">Límite más corto: ${minimo} horas. La devolución debe ser un día hábil y no exceder ${fecha(max)}. Si el límite cae en fin de semana, selecciona el viernes anterior.</p>`
      : `<p class="small muted">Escanea cada pieza devuelta, en cualquier orden, y registra su estado físico. Las piezas que no se escaneen podrán registrarse como perdidas.</p>`) +
    `<h3 style="margin-top:22px">${entregar ? 'Verificación de salida' : 'Revisión de devolución'} · ${piezas.length} pieza(s)</h3><p class="small">${entregar ? 'Material solicitado' : 'Material prestado'}: ${esc([...requeridos.values()].map((r) => `${r.nombre} × ${r.cantidad}`).join(', '))}</p><p class="small muted" id="lectura-progreso" aria-live="polite"></p>` +
    piezas
      .map(
        (x, n) =>
          `<div class="piece-row" data-row="${n}"><div><strong class="small">Pieza ${n + 1} de ${piezas.length}</strong><p class="small muted" id="piece-info-${n}" aria-live="polite">${ayudaLectura}</p></div><div><label for="piece-code-${n}">Escanear código</label><input class="scan-input piece-code" id="piece-code-${n}" name="codigo-${n}" autocomplete="off" ${entregar ? 'required' : ''} placeholder="Código de la pieza"></div><div><label for="piece-condition-${n}">Estado físico</label><select id="piece-condition-${n}" name="condicion-${n}" ${entregar ? 'required' : ''}><option value="">Seleccionar…</option>${condiciones('', false)}</select></div><div class="piece-notes"><label for="piece-notes-${n}">Observación de esta pieza</label><input id="piece-notes-${n}" name="notas-${n}" maxlength="2000" placeholder="Detalles de la revisión física"></div></div>`,
      )
      .join('') +
    (!entregar
      ? `<div id="faltantes" class="alerta" style="margin-top:15px" hidden><p id="faltantes-lista"></p><label class="check"><input name="confirmarPerdidas" type="checkbox"><span>Estas piezas no fueron devueltas: registrarlas como perdidas.</span></label><label for="notas-perdidas">Observación de la pérdida</label><input id="notas-perdidas" name="notasPerdidas" maxlength="2000" placeholder="Circunstancias informadas por el alumno"></div><p class="small muted" style="margin-top:15px">Los daños nuevos y pérdidas generarán una incidencia y un adeudo. Los defectos previos aceptados se conservarán en el historial.</p>`
      : '<p class="small muted" style="margin-top:15px">Puedes entregar cualquier pieza disponible del material solicitado; el sistema reasigna la reserva. Todo el material se utilizará exclusivamente dentro del plantel.</p>');
  let d;
  const campoCodigo = (n) => d.querySelector(`#piece-code-${n}`);
  function informar(n, texto, tipo = '') {
    const info = d.querySelector(`#piece-info-${n}`);
    info.textContent = texto;
    info.className = `small ${tipo === 'ok' ? 'lectura-ok' : tipo === 'error' ? 'lectura-error' : 'muted'}`;
    campoCodigo(n).toggleAttribute('aria-invalid', tipo === 'error');
  }
  function actualizar() {
    const validas = lecturas.filter(Boolean).length;
    d.querySelector('#lectura-progreso').textContent =
      `Lecturas válidas: ${validas} de ${piezas.length}.`;
    if (entregar) return;
    const leidas = new Set(lecturas.filter(Boolean).map((l) => l.codigo));
    const faltantes = piezas.filter((x) => !leidas.has(x.pieza?.codigo));
    d.querySelector('#faltantes').hidden = !faltantes.length;
    d.querySelector('#faltantes-lista').textContent = faltantes.length
      ? `Sin escanear: ${resumenMateriales({ piezas: faltantes })}.`
      : '';
  }
  // RN-09: cada lectura se valida al momento, sin depender del orden de las piezas.
  async function validarLectura(n) {
    const codigoPieza = campoCodigo(n).value.trim();
    lecturas[n] = null;
    try {
      if (!codigoPieza) return informar(n, ayudaLectura);
      const repetida = piezas.some(
        (_, i) => i !== n && campoCodigo(i).value.trim() === codigoPieza,
      );
      if (repetida) throw new Error(`La pieza ${codigoPieza} ya se escaneó en otra fila.`);
      if (entregar) {
        const pieza = await api(`/api/operacion/piezas/codigo/${encodeURIComponent(codigoPieza)}`);
        if (campoCodigo(n).value.trim() !== codigoPieza) return;
        const requerido = requeridos.get(pieza.materialId);
        if (!requerido)
          throw new Error(
            `La pieza ${codigoPieza} (${pieza.material.nombre}) no corresponde a esta solicitud. Entrega bloqueada.`,
          );
        if (!entregadas.has(codigoPieza) && pieza.estado !== 'DISPONIBLE')
          throw new Error(
            `La pieza ${codigoPieza} no está disponible (${etiqueta(pieza.estado)}). Escanea otra pieza de ${pieza.material.nombre}.`,
          );
        const otras = lecturas.filter((l, i) => i !== n && l?.materialId === pieza.materialId);
        if (otras.length >= requerido.cantidad)
          throw new Error(
            `Ya se escanearon las ${requerido.cantidad} pieza(s) solicitadas de ${requerido.nombre}.`,
          );
        lecturas[n] = { codigo: codigoPieza, materialId: pieza.materialId };
        informar(n, `${pieza.material.nombre} · corresponde a la solicitud.`, 'ok');
      } else {
        const x = entregadas.get(codigoPieza);
        if (!x) throw new Error(`La pieza ${codigoPieza} no forma parte de este préstamo.`);
        lecturas[n] = { codigo: codigoPieza, materialId: x.pieza.materialId };
        informar(
          n,
          `${x.pieza.material.nombre} · al entregar: ${etiqueta(x.condicionEntrega)}.`,
          'ok',
        );
      }
    } catch (e) {
      if (campoCodigo(n).value.trim() === codigoPieza) informar(n, e.message, 'error');
    } finally {
      actualizar();
    }
  }
  d = modal(
    `${entregar ? 'Entregar' : 'Devolver'} · Solicitud #${p.id}`,
    contenido,
    async (data, form) => {
      for (let n = 0; n < piezas.length; n++) await validarLectura(n);
      const body = { piezas: [] };
      for (let n = 0; n < piezas.length; n++) {
        const escrito = data[`codigo-${n}`]?.trim();
        if (escrito && !lecturas[n])
          throw new Error(`Pieza ${n + 1}: ${d.querySelector(`#piece-info-${n}`).textContent}`);
        if (!lecturas[n]) continue;
        if (!data[`condicion-${n}`])
          throw new Error(`Registra el estado físico de la pieza ${n + 1}.`);
        body.piezas.push({
          codigo: lecturas[n].codigo,
          condicion: data[`condicion-${n}`],
          notas: data[`notas-${n}`],
        });
      }
      if (entregar) {
        for (const [materialId, r] of requeridos) {
          const leidas = lecturas.filter((l) => l?.materialId === materialId).length;
          if (leidas !== r.cantidad)
            throw new Error(`Escanea ${r.cantidad} pieza(s) de ${r.nombre}; hay ${leidas}.`);
        }
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
        const leidas = new Set(body.piezas.map((x) => x.codigo));
        const faltantes = piezas.filter((x) => !leidas.has(x.pieza?.codigo));
        if (faltantes.length && !form.elements.confirmarPerdidas.checked)
          throw new Error(
            `Faltan ${faltantes.length} pieza(s) por escanear. Escanéalas o confirma que no fueron devueltas para registrarlas como perdidas.`,
          );
        for (const x of faltantes)
          body.piezas.push({
            codigo: x.pieza.codigo,
            condicion: 'PERDIDO',
            notas: data.notasPerdidas?.trim() || 'Pieza no devuelta en ventanilla.',
          });
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
  piezas.forEach((_, n) => campoCodigo(n).addEventListener('change', () => validarLectura(n)));
  actualizar();
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
  // En préstamos activos no se muestran los códigos de pieza para no sustituir el escaneo.
  const activo = ['PENDIENTE', 'PREPARADA', 'ENTREGADO'].includes(p.estado);
  const d = modal(
    `Solicitud #${p.id}`,
    `<div class="section-head"><strong>${esc(p.usuario?.nombre)} · ${esc(p.usuario?.matricula)}</strong>${badge(p.estado)}</div><p class="small">Solicitud: ${fecha(p.fechaSolicitud)}<br>Recolección: ${fecha(p.fechaRecoleccion)}<br>Entrega: ${fecha(p.fechaEntrega)}<br>Devolver: ${fecha(p.fechaDevolucion)}<br>Devuelto: ${fecha(p.fechaDevuelto)}</p><div class="table-wrap"><table><thead><tr><th>Material / Pieza</th><th>Entrega</th><th>Devolución</th><th>Notas</th></tr></thead><tbody>${(p.piezas || []).map((x) => `<tr><td>${esc(x.pieza?.material?.nombre)}${activo ? '' : `<small class="code">${esc(x.pieza?.codigo)}</small>`}</td><td>${esc(etiqueta(x.condicionEntrega))}</td><td>${esc(etiqueta(x.condicionDevuelto))}</td><td>${esc(x.notasEntrega)} ${esc(x.notasDevuelto)}</td></tr>`).join('') || tablaVacia(4)}</tbody></table></div>${(p.defectos || []).map((x) => `<p class="small" style="margin-top:15px">Defecto previo: ${esc(x.descripcion)} · ${esc(etiqueta(x.estado))} ${esc(x.respuesta)}</p>`).join('')}${(p.incidencias || []).map((i) => `<div class="alerta" style="margin-top:15px">Incidencia #${i.id}: ${esc(i.descripcion)}<div class="actions"><button type="button" class="mini sec" data-comprobante="${i.id}">Ver comprobante</button></div></div>`).join('')}`,
    async () => {},
    'Cerrar',
  );
  d.querySelector('[data-cerrar]').textContent = '×';
}
