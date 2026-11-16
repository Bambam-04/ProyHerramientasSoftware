'use strict';
let materiales = [],
  prestamos = [],
  practicas = [],
  cuenta = null,
  reglasActuales = {},
  carrito = new Map(),
  mesCalendario;
const materialIcon =
  '<svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M28 8h24M33 8v27L17 63q-4 9 7 9h32q11 0 7-9L47 35V8M25 49h30M31 59h14"/><circle cx="45" cy="48" r="3"/><circle cx="36" cy="37" r="2"/></svg>';
if (requerirSesion({ roles: ['ALUMNO', 'DOCENTE'] }))
  iniciarAlumno().catch((e) => mensaje(e.message, 'error'));
async function iniciarAlumno() {
  pestañas();
  const r = await reglas();
  reglasActuales = r.configuracion || {};
  try {
    carrito = new Map(JSON.parse(sessionStorage.getItem('carrito') || '[]'));
  } catch {
    carrito = new Map();
  }
  const anticipacion = Number(reglasActuales.anticipacionMinMinutos || 0);
  let inicio = new Date(Date.now() + Math.max(anticipacion + 5, 5) * 60000);
  let p = partesFecha(inicio);
  let dia = p.dia;
  let hora = p.hora;
  const abre = reglasActuales.horaApertura || '07:00',
    cierra = reglasActuales.horaCierre || '20:00';
  if (hora < abre) hora = abre;
  if (hora >= cierra) {
    dia = incrementarDia(dia, 1);
    hora = abre;
  }
  while (finDeSemana(dia)) {
    dia = incrementarDia(dia, 1);
    hora = abre;
  }
  $('recogida-dia').value = dia;
  $('recogida-hora').value = hora;
  $('recogida-hora').min = abre;
  $('recogida-hora').max = cierra;
  mesCalendario = dia.slice(0, 7);
  $('horario-ayuda').textContent =
    `Lunes a viernes, ${abre}–${cierra}. Hasta ${reglasActuales.anticipacionMaxHoras || 168} h de anticipación. Horario: ${zonaHoraria}.`;
  dibujarCalendario();
  $('buscar').addEventListener('input', dibujarMateriales);
  $('categoria').onchange = dibujarMateriales;
  $('buscar-practica').oninput = dibujarPracticas;
  $('solicitud-form').onsubmit = enviarSolicitud;
  document.body.addEventListener('click', accionesAlumno);
  await cargarAlumno();
  polling(cargarAlumno);
}
function incrementarDia(dia, n) {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dibujarCalendario() {
  const [y, m] = mesCalendario.split('-').map(Number);
  const primero = new Date(Date.UTC(y, m - 1, 1));
  const offset = (primero.getUTCDay() + 6) % 7;
  const inicio = new Date(Date.UTC(y, m - 1, 1 - offset));
  const hoy = partesFecha().dia;
  const max = partesFecha(Date.now() + (reglasActuales.anticipacionMaxHoras || 168) * 3600000).dia;
  let c = `<div class="calendar-nav"><button type="button" class="mini sec" data-mes="-1" aria-label="Mes anterior">‹</button><strong>${esc(new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(primero))}</strong><button type="button" class="mini sec" data-mes="1" aria-label="Mes siguiente">›</button></div><div class="calendar-grid">${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((x) => `<span>${x}</span>`).join('')}`;
  for (let n = 0; n < 42; n++) {
    const d = new Date(inicio);
    d.setUTCDate(d.getUTCDate() + n);
    const dia = d.toISOString().slice(0, 10);
    const disabled = finDeSemana(dia) || dia < hoy || dia > max;
    c += `<button type="button" data-dia="${dia}" class="${dia === $('recogida-dia').value ? 'selected' : ''} ${d.getUTCMonth() !== m - 1 ? 'outside' : ''}" ${disabled ? 'disabled' : ''} aria-label="${esc(fecha(d, true))}" aria-pressed="${dia === $('recogida-dia').value}">${d.getUTCDate()}</button>`;
  }
  $('calendario').innerHTML = c + '</div>';
}
async function cargarAlumno() {
  const [m, p, c, n, a, pr] = await Promise.all([
    api('/api/materiales'),
    api('/api/mis-prestamos'),
    api('/api/mi-cuenta'),
    api('/api/notificaciones'),
    api('/api/avisos'),
    api('/api/practicas'),
  ]);
  materiales = lista(m);
  prestamos = lista(p);
  cuenta = c;
  practicas = lista(pr);
  const categoria = $('categoria').value;
  const categorias = [...new Set(materiales.map((x) => x.categoria).filter(Boolean))].sort();
  const opciones =
    '<option value="">Todas las categorías</option>' +
    categorias.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
  if ($('categoria').innerHTML !== opciones) {
    $('categoria').innerHTML = opciones;
    $('categoria').value = categoria;
  }
  if (!$('materiales').contains(document.activeElement)) dibujarMateriales();
  dibujarCarrito();
  dibujarPrestamos();
  dibujarCuenta();
  dibujarPracticas();
  dibujarNotificaciones(lista(n));
  $('avisos').innerHTML = lista(a)
    .map(
      (x) =>
        `<div class="notice"><strong>${esc(x.titulo)}</strong><p>${esc(x.contenido)}</p></div>`,
    )
    .join('');
}
function dibujarMateriales() {
  const q = $('buscar').value.trim().toLocaleLowerCase('es'),
    categoria = $('categoria').value;
  const filas = materiales.filter(
    (m) =>
      (!categoria || m.categoria === categoria) &&
      `${m.nombre} ${m.categoria} ${m.caracteristicas}`.toLocaleLowerCase('es').includes(q),
  );
  $('materiales').innerHTML = filas.length
    ? filas
        .map((m) => {
          const disponible = m.disponibles > 0;
          const estado = disponible
            ? 'Disponible'
            : m.estadoInventario === 'MANTENIMIENTO' || /mantenimiento|fuera/i.test(m.estado)
              ? 'Fuera de servicio'
              : 'Agotado';
          const image =
            typeof m.fotografia === 'string' &&
            /^(https?:\/\/|\/|data:image\/(png|jpeg|webp);base64,)/i.test(m.fotografia)
              ? `<img src="${esc(m.fotografia)}" alt="${esc(m.nombre)}" loading="lazy" referrerpolicy="no-referrer">`
              : materialIcon;
          return `<article class="material"><div class="material-image">${image}</div><div class="material-body"><span class="small muted">${esc(m.categoria || 'Material de laboratorio')}</span><h3>${esc(m.nombre)}</h3><p>${esc(m.caracteristicas || 'Consulta las condiciones del material al recogerlo.')}</p><div class="material-meta"><span>${esc(estado)} · ${m.disponibles} de ${m.cantidadTotal}</span><span>Máx. ${m.maxHoras} h</span></div><div class="actions">${disponible ? `<input type="number" id="cantidad-${m.id}" value="1" min="1" max="${m.disponibles}" aria-label="Cantidad de ${esc(m.nombre)}"><button class="mini" data-agregar="${m.id}" ${cuenta?.elegibilidad?.puedeSolicitar === false ? 'disabled' : ''}>Agregar</button>` : `<button class="mini sec" data-interes="${m.id}">Avisarme cuando esté disponible</button>`}</div></div></article>`;
        })
        .join('')
    : '<p class="empty">No se encontraron materiales con esos filtros.</p>';
}
function dibujarCarrito() {
  let total = 0;
  for (const [id, cantidad] of carrito) {
    if (!materiales.some((m) => m.id === Number(id))) carrito.delete(id);
    else total += cantidad;
  }
  sessionStorage.setItem('carrito', JSON.stringify([...carrito]));
  $('cart-count').textContent = total;
  $('cart-items').innerHTML = carrito.size
    ? [...carrito]
        .map(([id, cantidad]) => {
          const m = materiales.find((x) => x.id === Number(id));
          return `<div class="cart-item"><div><strong>${esc(m.nombre)}</strong><small>${cantidad} pieza(s) · Máx. ${m.maxHoras} h${cantidad > m.disponibles ? ' · Revisa disponibilidad' : ''}</small></div><button type="button" class="mini sec" data-quitar="${id}" aria-label="Quitar ${esc(m.nombre)}">×</button></div>`;
        })
        .join('')
    : 'Agrega materiales del catálogo.';
  $('enviar').disabled = !carrito.size || cuenta?.elegibilidad?.puedeSolicitar === false;
  $('solicitud-form')
    .closest('.cart')
    .classList.toggle('cart-empty', carrito.size === 0);
}
function dibujarPrestamos() {
  const abiertos = new Set(
    [...document.querySelectorAll('#mios details[open]')].map((x) => x.dataset.detalle),
  );
  $('cuenta-prestamos').textContent = prestamos.filter((x) =>
    ['PENDIENTE', 'PREPARADA', 'ENTREGADO'].includes(x.estado),
  ).length;
  $('mios').innerHTML = prestamos.length
    ? prestamos
        .map(
          (p) =>
            `<article class="loan-card"><div class="section-head"><strong>Solicitud #${p.id}</strong>${badge(p.estado)}</div><p class="small">${esc(detallesPrestamo(p))}</p><div class="loan-dates"><span>Solicitado: ${fecha(p.fechaSolicitud)}</span><span>Recoger: ${fecha(p.fechaRecoleccion)}</span><span>Devolver: ${fecha(p.fechaDevolucion)}</span>${p.fechaDevuelto ? `<span>Devuelto: ${fecha(p.fechaDevuelto)}</span>` : ''}</div>${p.estado === 'PREPARADA' ? `<p class="small muted">Presenta este código y tu identificación en ventanilla. Recoge antes de ${fecha(p.limiteRecogida)}.</p><div class="loan-code">${esc(p.codigo)}</div>` : ''}<div class="actions">${p.estado === 'PENDIENTE' ? `<button class="mini sec" data-cancelar="${p.id}">Cancelar solicitud</button>` : ''}${p.estado === 'ENTREGADO' ? `<button class="mini sec" data-defecto="${p.id}">Reportar defecto previo</button>` : ''}</div><details data-detalle="${p.id}" ${abiertos.has(String(p.id)) ? 'open' : ''}><summary>Piezas, observaciones e incidencias</summary><div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Pieza</th><th>Entrega</th><th>Devolución</th><th>Observaciones</th></tr></thead><tbody>${(p.piezas || []).map((x) => `<tr><td>${esc(x.pieza?.material?.nombre)}<small class="code">${esc(x.pieza?.codigo)}</small></td><td>${esc(etiqueta(x.condicionEntrega))}</td><td>${esc(etiqueta(x.condicionDevuelto))}</td><td>${esc(x.notasEntrega || '')} ${esc(x.notasDevuelto || '')}</td></tr>`).join('') || tablaVacia(4)}</tbody></table></div>${(p.defectos || []).map((x) => `<div class="notice" style="margin-top:10px"><strong>Defecto previo · ${esc(etiqueta(x.estado))}</strong><p>${esc(x.descripcion)}</p>${x.respuesta ? `<p>${esc(x.respuesta)}</p>` : ''}</div>`).join('')}${(p.incidencias || []).map((i) => `<div class="alerta" style="margin-top:10px"><strong>Incidencia #${i.id} · ${esc(i.tipo)}</strong><p>${esc(i.descripcion)}</p><button class="sec mini" data-comprobante="${i.id}">Consultar comprobante</button></div>`).join('')}</details></article>`,
        )
        .join('')
    : '<p class="empty">Aún no has solicitado material.</p>';
}
function dibujarCuenta() {
  const e = cuenta?.elegibilidad || {};
  $('restriccion').hidden = e.puedeSolicitar !== false;
  $('restriccion').textContent =
    e.motivo || 'Tu cuenta tiene una restricción. Consulta al administrador.';
  $('estado-cuenta').innerHTML =
    `<strong>${esc(etiqueta(e.estado) || 'Cuenta activa')}</strong><p class="muted" style="margin-top:7px">${esc(e.motivo || 'Puedes solicitar materiales disponibles.')}</p>`;
  $('convenios').innerHTML = lista(cuenta?.convenios).length
    ? lista(cuenta.convenios)
        .map(
          (c) =>
            `<article class="loan-card"><div class="section-head"><strong>Convenio #${c.id}</strong>${badge(c.estado)}</div><p>${esc(c.descripcion)}</p><p class="small muted">Material: ${esc(c.adeudo?.incidencia?.piezaPrestamo?.pieza?.material?.nombre || c.adeudo?.incidencia?.descripcion || 'Consulta el comprobante de incidencia')}</p><p class="small">Límite de reposición: <strong>${fecha(c.fechaLimite)}</strong></p>${c.comprobante ? `<p class="small">Comprobante: ${esc(c.comprobante)}</p>` : ''}</article>`,
        )
        .join('')
    : '<p class="muted small">No tienes convenios de reposición.</p>';
  $('adeudos').innerHTML = lista(cuenta?.adeudos).length
    ? lista(cuenta.adeudos)
        .map(
          (a) =>
            `<article class="loan-card"><div class="section-head"><strong>Adeudo #${a.id}</strong>${badge(a.estado)}</div><p>${esc(a.incidencia?.descripcion || a.notas || 'Incidencia de material')}</p><p class="small muted">Registrado: ${fecha(a.creadoEn)}</p>${a.incidenciaId ? `<button class="sec mini" data-comprobante="${a.incidenciaId}">Comprobante de incidencia</button>` : ''}</article>`,
        )
        .join('')
    : '<p class="muted small">No tienes adeudos registrados.</p>';
}
function dibujarNotificaciones(n) {
  $('cuenta-notificaciones').textContent = n.filter((x) => !x.leida).length;
  $('notificaciones').innerHTML = n.length
    ? n
        .map(
          (x) =>
            `<article class="notification ${x.leida ? 'leida' : ''}"><div><p>${esc(x.mensaje)}</p><time>${fecha(x.creadoEn)}</time></div>${!x.leida ? `<button class="mini sec" data-leer="${x.id}">Marcar leída</button>` : ''}</article>`,
        )
        .join('')
    : '<p class="empty">No tienes notificaciones.</p>';
}
function dibujarPracticas() {
  const q = $('buscar-practica').value.toLocaleLowerCase('es');
  const p = practicas.filter((x) => x.nombre.toLocaleLowerCase('es').includes(q));
  $('practicas').innerHTML = p.length
    ? p
        .map(
          (x) =>
            `<div class="notice"><strong>${esc(x.nombre)}</strong><p class="small">${esc(x.descripcion)}</p><p class="small muted">${(
              x.materiales || []
            )
              .map(
                (i) =>
                  `${i.cantidad} × ${materiales.find((m) => m.id === i.materialId)?.nombre || 'Material no disponible'}`,
              )
              .map(esc)
              .join(
                ', ',
              )}</p><button class="sec mini" data-practica="${x.id}">Agregar materiales disponibles</button></div>`,
        )
        .join('')
    : '<p class="small muted">No se encontraron prácticas.</p>';
}
async function enviarSolicitud(event) {
  event.preventDefault();
  const boton = $('enviar');
  boton.disabled = true;
  try {
    if (!carrito.size) throw new Error('Agrega al menos un material.');
    if (finDeSemana($('recogida-dia').value))
      throw new Error('Selecciona un día de lunes a viernes.');
    if (!$('uso-interno').checked) throw new Error('Confirma el uso exclusivo dentro del plantel.');
    const r = await api('/api/prestamos', {
      method: 'POST',
      body: {
        items: [...carrito].map(([materialId, cantidad]) => ({
          materialId: Number(materialId),
          cantidad,
        })),
        fechaRecoleccion: desdeLocal(`${$('recogida-dia').value}T${$('recogida-hora').value}`),
        aceptaUsoInterno: true,
      },
    });
    carrito.clear();
    $('uso-interno').checked = false;
    await cargarAlumno();
    mensaje(r.mensaje || 'Solicitud enviada. Te avisaremos cuando esté preparada.');
    document.querySelector('[data-tab="prestamos"]').click();
  } catch (e) {
    mensaje(e.message, 'error');
  } finally {
    dibujarCarrito();
  }
}
async function accionesAlumno(event) {
  const b = event.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.mes) {
      const [y, m] = mesCalendario.split('-').map(Number);
      mesCalendario = new Date(Date.UTC(y, m - 1 + Number(b.dataset.mes), 1))
        .toISOString()
        .slice(0, 7);
      dibujarCalendario();
    } else if (b.dataset.dia) {
      $('recogida-dia').value = b.dataset.dia;
      dibujarCalendario();
    } else if (b.dataset.agregar) {
      const id = Number(b.dataset.agregar),
        m = materiales.find((x) => x.id === id),
        cantidad = Number($(`cantidad-${id}`).value),
        actual = carrito.get(id) || 0;
      if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad + actual > m.disponibles)
        throw new Error(
          `Hay ${m.disponibles} pieza(s) disponibles. Revisa las cantidades de tu solicitud.`,
        );
      carrito.set(id, cantidad + actual);
      dibujarCarrito();
      mensaje(`${m.nombre} agregado a tu solicitud.`);
    } else if (b.dataset.quitar) {
      carrito.delete(Number(b.dataset.quitar));
      dibujarCarrito();
    } else if (b.dataset.interes) {
      b.disabled = true;
      await api(`/api/materiales/${b.dataset.interes}/interes`, { method: 'POST' });
      mensaje('Te notificaremos cuando este material vuelva a estar disponible.');
    } else if (b.dataset.cancelar) {
      if (!confirm('¿Cancelar esta solicitud y liberar todos los materiales reservados?')) return;
      await api(`/api/prestamos/${b.dataset.cancelar}/cancelar`, { method: 'POST' });
      await cargarAlumno();
      mensaje('Solicitud cancelada.');
    } else if (b.dataset.leer) {
      await api(`/api/notificaciones/${b.dataset.leer}/leer`, { method: 'POST' });
      await cargarAlumno();
    } else if (b.dataset.comprobante) {
      await descargar(
        `/api/incidencias/${b.dataset.comprobante}/comprobante`,
        `incidencia-${b.dataset.comprobante}.html`,
        true,
      );
    } else if (b.dataset.defecto) {
      reportarDefecto(prestamos.find((p) => p.id === Number(b.dataset.defecto)));
    } else if (b.dataset.practica) {
      const practica = practicas.find((p) => p.id === Number(b.dataset.practica));
      let agregados = 0;
      for (const i of practica.materiales || []) {
        const m = materiales.find((m) => m.id === i.materialId);
        const actual = carrito.get(i.materialId) || 0;
        if (m && m.disponibles >= i.cantidad + actual) {
          carrito.set(i.materialId, i.cantidad + actual);
          agregados++;
        }
      }
      dibujarCarrito();
      mensaje(
        agregados
          ? 'Se agregaron los materiales con disponibilidad suficiente.'
          : 'Los materiales de esta práctica no tienen disponibilidad suficiente.',
        agregados ? 'ok' : 'error',
      );
    }
  } catch (e) {
    mensaje(e.message, 'error');
  } finally {
    if (b.dataset.interes) b.disabled = false;
  }
}
function reportarDefecto(p) {
  modal(
    `Reportar defecto previo · Solicitud #${p.id}`,
    `<p class="muted small">Describe el defecto observado al recibir la pieza. El encargado deberá revisarlo y aceptar el reporte.</p><label for="def-pieza">Pieza afectada</label><select id="def-pieza" name="prestamoPiezaId" required>${p.piezas.map((x) => `<option value="${x.id}">${esc(x.pieza.material.nombre)} · ${esc(x.pieza.codigo)}</option>`).join('')}</select><label for="def-condicion">Condición observada</label><select id="def-condicion" name="condicion">${condiciones('RAYADO').replace(/<option value="INTEGRO"[^>]*>[^<]*<\/option>/, '')}</select><label for="def-descripcion">Describe el defecto</label><textarea id="def-descripcion" name="descripcion" maxlength="2000" required></textarea>`,
    async (d) => {
      await api(`/api/prestamos/${p.id}/defectos`, {
        method: 'POST',
        body: { ...d, prestamoPiezaId: Number(d.prestamoPiezaId) },
      });
      await cargarAlumno();
      mensaje('Reporte enviado al encargado para su revisión.');
    },
    'Enviar reporte',
  );
}
