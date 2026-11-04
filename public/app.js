// Utilidades compartidas
async function api(url, { method = 'GET', body, sinRedirect = false } = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !sinRedirect) { localStorage.clear(); location.href = '/index.html'; }
  if (!res.ok) throw new Error(data.error || 'Ocurrió un error inesperado.');
  return data;
}

function sesion() {
  try { return JSON.parse(localStorage.getItem('usuario')); } catch { return null; }
}

// Redirige al login si no hay sesión o si el rol no corresponde
function requerirSesion({ admin = false } = {}) {
  const u = sesion();
  if (!u || !localStorage.getItem('token')) { location.href = '/index.html'; return null; }
  if (admin && u.rol !== 'ADMIN') { location.href = '/catalogo.html'; return null; }
  if (!admin && u.rol === 'ADMIN') { location.href = '/admin.html'; return null; }
  const el = document.getElementById('quien');
  if (el) el.textContent = `${u.nombre} (${u.rol.toLowerCase()})`;
  return u;
}

function salir() { localStorage.clear(); location.href = '/index.html'; }

function esc(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fecha(f) { return f ? new Date(f).toLocaleDateString('es-MX') : '—'; }

function mostrar(id, texto, tipo) {
  const el = document.getElementById(id);
  el.textContent = texto;
  el.className = 'msg ' + (tipo || '');
}
