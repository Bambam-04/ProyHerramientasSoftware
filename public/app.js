/* Utilidades de interfaz. Las autorizaciones se verifican también en el servidor. */
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let zonaHoraria = 'America/Tijuana';
const etiquetas = {
  INACTIVO: 'Inactivo',
  BLOQUEADO: 'Bloqueado',
  CONVENIO_ACTIVO: 'Convenio vigente',
  CON_ADEUDO_VENCIDO: 'Con adeudo vencido',
  CON_INCIDENCIA_PENDIENTE: 'Con incidencia pendiente',
  SISTEMA: 'Sistema',
  LIQUIDADA: 'Liquidada',
  ADMIN: 'Administrador',
  ENCARGADO: 'Ventanilla',
  ALUMNO: 'Alumno',
  DOCENTE: 'Docente',
  PENDIENTE: 'Pendiente',
  PREPARADA: 'Preparada',
  ENTREGADO: 'En préstamo',
  DEVUELTO: 'Devuelto',
  RECHAZADO: 'Rechazado',
  CANCELADO: 'Cancelado',
  NO_RECOGIDO: 'No recogido',
  INCIDENCIA: 'Con incidencia',
  INTEGRO: 'Íntegro',
  BUENO: 'Íntegro',
  RAYADO: 'Rayado',
  ASTILLADO: 'Astillado',
  DANADO: 'Dañado',
  ROTO: 'Roto',
  PERDIDO: 'Perdido',
  ACTIVO: 'Activo',
  VENCIDO: 'Vencido',
  LIQUIDADO: 'Liquidado',
  CONVENIO: 'Con convenio',
  ACEPTADO: 'Aceptado',
  DISPONIBLE: 'Disponible',
  RESERVADA: 'Reservada',
  PRESTADA: 'En préstamo',
  MANTENIMIENTO: 'En mantenimiento',
  BAJA: 'Baja',
  PERDIDA: 'Perdida',
};
const etiqueta = (value) => etiquetas[value] || value || '—';
const badge = (value) => `<span class="badge ${esc(value)}">${esc(etiqueta(value))}</span>`;
function sesion() {
  try {
    return JSON.parse(sessionStorage.getItem('usuario'));
  } catch {
    return null;
  }
}
function guardarSesion(data) {
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  sessionStorage.setItem('token', data.token);
  sessionStorage.setItem('usuario', JSON.stringify(data.usuario));
}
function destino(rol) {
  return rol === 'ADMIN'
    ? '/admin.html'
    : rol === 'ENCARGADO'
      ? '/operacion.html'
      : '/catalogo.html';
}
async function salir(revocar = true) {
  const token = sessionStorage.getItem('token');
  sessionStorage.clear();
  localStorage.removeItem('token');
  localStorage.removeItem('usuario');
  try {
    if (revocar && token)
      await fetch('/api/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000),
      });
  } catch {
  } finally {
    location.href = '/index.html';
  }
}
function requerirSesion({ roles } = {}) {
  const u = sesion();
  if (!u || !sessionStorage.getItem('token')) {
    location.replace('/index.html');
    return null;
  }
  if (roles && !roles.includes(u.rol)) {
    location.replace(destino(u.rol));
    return null;
  }
  if ($('quien')) $('quien').textContent = `${u.nombre} · ${etiqueta(u.rol)}`;
  if ($('nav-admin')) $('nav-admin').hidden = u.rol !== 'ADMIN';
  document.querySelectorAll('[data-salir]').forEach((b) => (b.onclick = salir));
  document.querySelectorAll('[data-password]').forEach((b) => (b.onclick = cambiarPassword));
  if (u.debeCambiarPassword) setTimeout(cambiarPassword, 100);
  return u;
}
async function api(url, { method = 'GET', body, sinRedirect = false, signal } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(sessionStorage.getItem('token')
          ? { Authorization: `Bearer ${sessionStorage.getItem('token')}` }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal || AbortSignal.timeout(25000),
      cache: 'no-store',
    });
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError')
      throw new Error('La consulta tardó demasiado. Vuelve a intentarlo.');
    throw new Error('No hay conexión con el servidor. Comprueba la red e intenta de nuevo.');
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !sinRedirect) {
    salir(false);
    throw new Error('Tu sesión expiró. Inicia sesión nuevamente.');
  }
  if (!response.ok) {
    const e = new Error(data.error || 'No se pudo completar la operación.');
    e.status = response.status;
    e.data = data;
    throw e;
  }
  return data;
}
async function descargar(url, nombre, abrir = false) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${sessionStorage.getItem('token')}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'No se pudo generar el archivo.');
  }
  const blob = await response.blob();
  const objectURL = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectURL;
  if (abrir) {
    a.target = '_blank';
    a.rel = 'noopener';
  } else a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(objectURL), 60000);
}
function fecha(value, soloDia = false) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: zonaHoraria,
    dateStyle: 'medium',
    ...(soloDia ? {} : { timeStyle: 'short' }),
  }).format(d);
}
function partesFecha(value = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zonaHoraria,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(value))
      .map((x) => [x.type, x.value]),
  );
  return {
    dia: `${p.year}-${p.month}-${p.day}`,
    hora: `${p.hour}:${p.minute}`,
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
  };
}
function inputFecha(value = new Date()) {
  const p = partesFecha(value);
  return `${p.dia}T${p.hora}`;
}
function desdeLocal(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || ''))
    throw new Error('Selecciona una fecha y hora válidas.');
  const [y, m, d, h, n] = value.split(/[-T:]/).map(Number);
  const target = Date.UTC(y, m - 1, d, h, n);
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = partesFecha(instant);
    instant += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  if (inputFecha(instant) !== value)
    throw new Error('La hora elegida no existe en la zona horaria del plantel.');
  return new Date(instant).toISOString();
}
function finDeSemana(dia) {
  const d = new Date(`${dia}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}
function mostrar(id, texto, tipo = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = texto;
  el.className = `msg ${tipo}`;
  el.hidden = !texto;
}
function mensaje(texto, tipo = 'ok') {
  mostrar('msg', texto, tipo);
  if (tipo === 'error') $('msg')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function tablaVacia(c, texto = 'No hay registros.') {
  return `<tr><td colspan="${c}" class="empty">${esc(texto)}</td></tr>`;
}
function lista(v) {
  return Array.isArray(v)
    ? v
    : Array.isArray(v?.registros)
      ? v.registros
      : Array.isArray(v?.datos)
        ? v.datos
        : [];
}
function detallesPrestamo(p) {
  return (
    p.piezas
      ?.map((x) => `${x.pieza?.material?.nombre || 'Material'} (${x.pieza?.codigo || ''})`)
      .join(', ') ||
    p.material?.nombre ||
    'Sin piezas'
  );
}
function condiciones(selected = 'INTEGRO', perdido = false) {
  return ['INTEGRO', 'RAYADO', 'ASTILLADO', 'DANADO', 'ROTO', ...(perdido ? ['PERDIDO'] : [])]
    .map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${etiqueta(c)}</option>`)
    .join('');
}
async function reglas() {
  const data = await api('/api/reglas');
  zonaHoraria = data.zonaHoraria || zonaHoraria;
  document.querySelectorAll('[data-zona]').forEach((el) => (el.textContent = zonaHoraria));
  return data;
}
function pestañas() {
  document.querySelectorAll('[data-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        document
          .querySelectorAll('[data-panel]')
          .forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
        document.querySelectorAll('[data-tab]').forEach((x) => {
          x.classList.toggle('selected', x === b);
          x.setAttribute('aria-current', x === b ? 'page' : 'false');
        });
        document.dispatchEvent(new CustomEvent('cima:tab', { detail: b.dataset.tab }));
      }),
  );
}
function polling(fn, milisegundos = 5000) {
  let busy = false;
  const tick = async () => {
    if (document.hidden || busy) return;
    busy = true;
    try {
      await fn();
      mostrar('conexion', '');
    } catch (e) {
      mostrar('conexion', e.message, 'error');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, milisegundos);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  return tick;
}
function modal(titulo, contenido, guardar, etiquetaBoton = 'Guardar') {
  let d = $('dialogo');
  if (d) d.remove();
  d = document.createElement('dialog');
  d.id = 'dialogo';
  d.innerHTML = `<form id="modal-form"><div class="section-head"><h2>${esc(titulo)}</h2><button type="button" class="icon sec" data-cerrar aria-label="Cerrar">×</button></div><div class="modal-body">${contenido}</div><div id="modal-msg" class="msg" role="alert" hidden></div><div class="actions modal-actions"><button type="button" class="sec" data-cerrar>Cancelar</button><button type="submit" id="modal-submit">${esc(etiquetaBoton)}</button></div></form>`;
  document.body.appendChild(d);
  d.querySelectorAll('[data-cerrar]').forEach((b) => (b.onclick = () => d.close()));
  $('modal-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const b = $('modal-submit');
    b.disabled = true;
    mostrar('modal-msg', '');
    try {
      await guardar(Object.fromEntries(new FormData(ev.target)), ev.target);
      d.close();
    } catch (e) {
      mostrar('modal-msg', e.message, 'error');
    } finally {
      b.disabled = false;
    }
  };
  d.showModal();
  return d;
}
async function cambiarPassword() {
  modal(
    'Cambiar contraseña',
    `<p class="muted">Usa al menos 8 caracteres, con letras y números.</p><label for="pass-actual">Contraseña actual</label><input id="pass-actual" name="passwordActual" type="password" autocomplete="current-password" required><label for="pass-nuevo">Nueva contraseña</label><input id="pass-nuevo" name="passwordNuevo" type="password" minlength="8" maxlength="72" autocomplete="new-password" required><label for="pass-confirmar">Repite la nueva contraseña</label><input id="pass-confirmar" name="confirmar" type="password" minlength="8" autocomplete="new-password" required>`,
    async (d) => {
      if (d.passwordNuevo !== d.confirmar) throw new Error('Las contraseñas nuevas no coinciden.');
      const r = await api('/api/password', {
        method: 'POST',
        body: { passwordActual: d.passwordActual, passwordNuevo: d.passwordNuevo },
      });
      const u = sesion();
      u.debeCambiarPassword = false;
      sessionStorage.setItem('usuario', JSON.stringify(u));
      if (r.token) sessionStorage.setItem('token', r.token);
      mensaje(r.mensaje || 'Contraseña actualizada.');
      setTimeout(() => location.reload(), 100);
    },
  );
}
function serializeForm(form) {
  const d = Object.fromEntries(new FormData(form));
  for (const el of form.querySelectorAll('[type=checkbox][name]')) d[el.name] = el.checked;
  return d;
}
