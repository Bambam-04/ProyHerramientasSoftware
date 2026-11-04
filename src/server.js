require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const SECRET = process.env.JWT_SECRET || 'cambia-este-secreto';
const DOMINIO = process.env.DOMINIO_INSTITUCIONAL || 'uabc.edu.mx';
const MAX_INTENTOS = 5;
const BLOQUEO_MIN = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- Autenticación ----------
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.usuario = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Inicia sesión para continuar.' });
  }
}
function soloAdmin(req, res, next) {
  if (req.usuario.rol !== 'ADMIN') return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
  next();
}

app.post('/api/registro', async (req, res) => {
  const { matricula, correo, password } = req.body || {};
  if (!matricula || !correo || !password) return res.status(400).json({ error: 'Todos los campos son obligatorios.' });

  const mat = String(matricula).trim();
  const mail = String(correo).trim().toLowerCase();
  if (!EMAIL_RE.test(mail)) return res.status(400).json({ error: 'El formato del correo no es válido.' });
  if (!mail.endsWith('@' + DOMINIO)) return res.status(400).json({ error: `Usa tu correo institucional (@${DOMINIO}).` });
  if (String(password).length < 8 || !/\d/.test(password) || !/[A-Za-z]/.test(password))
    return res.status(400).json({ error: 'La contraseña debe tener mínimo 8 caracteres, con letras y números.' });

  const padron = await prisma.padron.findUnique({ where: { matricula: mat } });
  if (!padron || !padron.activo) return res.status(403).json({ error: 'La matrícula no existe en el padrón o no está activa.' });

  const duplicado = await prisma.usuario.findFirst({ where: { OR: [{ matricula: mat }, { correo: mail }] } });
  if (duplicado) return res.status(409).json({ error: 'Ya existe una cuenta con esa matrícula o correo.' });

  await prisma.usuario.create({
    data: { matricula: mat, nombre: padron.nombre, correo: mail, passwordHash: await bcrypt.hash(String(password), 10), rol: padron.rol },
  });
  res.status(201).json({ mensaje: 'Cuenta creada. Ya puedes iniciar sesión.' });
});

app.post('/api/login', async (req, res) => {
  const { correo, password } = req.body || {};
  if (!correo || !password) return res.status(400).json({ error: 'Escribe tu correo y tu contraseña.' });

  const u = await prisma.usuario.findUnique({ where: { correo: String(correo).trim().toLowerCase() } });
  if (!u) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });

  if (u.bloqueadoHasta && u.bloqueadoHasta > new Date())
    return res.status(423).json({ error: `Cuenta bloqueada temporalmente. Intenta de nuevo en ${BLOQUEO_MIN} minutos.` });

  const ok = await bcrypt.compare(String(password), u.passwordHash);
  if (!ok) {
    const intentos = u.intentos + 1;
    const bloquear = intentos >= MAX_INTENTOS;
    await prisma.usuario.update({
      where: { id: u.id },
      data: { intentos: bloquear ? 0 : intentos, bloqueadoHasta: bloquear ? new Date(Date.now() + BLOQUEO_MIN * 60000) : null },
    });
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }

  await prisma.usuario.update({ where: { id: u.id }, data: { intentos: 0, bloqueadoHasta: null } });
  const token = jwt.sign({ id: u.id, rol: u.rol, nombre: u.nombre }, SECRET, { expiresIn: '2h' });
  res.json({ token, usuario: { nombre: u.nombre, rol: u.rol } });
});

// ---------- Catálogo ----------
async function catalogo() {
  const materiales = await prisma.material.findMany({ where: { estado: { not: 'BAJA' } }, orderBy: { nombre: 'asc' } });
  const ocupado = await prisma.prestamo.groupBy({
    by: ['materialId'],
    where: { estado: { in: ['PENDIENTE', 'ENTREGADO'] } },
    _sum: { cantidad: true },
  });
  const mapa = Object.fromEntries(ocupado.map((o) => [o.materialId, o._sum.cantidad || 0]));
  return materiales.map((m) => {
    const disponibles = m.estado === 'MANTENIMIENTO' ? 0 : Math.max(m.cantidadTotal - (mapa[m.id] || 0), 0);
    const estado = m.estado === 'MANTENIMIENTO' ? 'En mantenimiento' : disponibles > 0 ? 'Disponible' : 'Prestado';
    return { id: m.id, nombre: m.nombre, cantidadTotal: m.cantidadTotal, disponibles, estado };
  });
}

app.get('/api/materiales', auth, async (req, res) => res.json(await catalogo()));

// ---------- Préstamos (usuario) ----------
app.post('/api/prestamos', auth, async (req, res) => {
  if (req.usuario.rol === 'ADMIN') return res.status(403).json({ error: 'El administrador no solicita préstamos.' });
  const { materialId, cantidad, fechaDevolucion } = req.body || {};
  const cant = Number(cantidad);
  if (!materialId || !Number.isInteger(cant) || cant < 1) return res.status(400).json({ error: 'Indica el material y una cantidad válida.' });

  const fecha = new Date(fechaDevolucion);
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  if (!fechaDevolucion || isNaN(fecha) || fecha < hoy) return res.status(400).json({ error: 'La fecha de devolución debe ser hoy o posterior.' });

  const item = (await catalogo()).find((m) => m.id === Number(materialId));
  if (!item) return res.status(404).json({ error: 'El material no existe.' });
  if (item.estado === 'En mantenimiento') return res.status(409).json({ error: 'El material está en mantenimiento y no se puede solicitar.' });
  if (item.disponibles === 0) return res.status(409).json({ error: 'El material está prestado en este momento.' });
  if (cant > item.disponibles) return res.status(409).json({ error: `Solo hay ${item.disponibles} pieza(s) disponible(s).` });

  const p = await prisma.prestamo.create({
    data: { usuarioId: req.usuario.id, materialId: item.id, cantidad: cant, fechaDevolucion: fecha },
  });
  res.status(201).json({ mensaje: 'Solicitud enviada. Espera la validación del administrador.', id: p.id });
});

app.get('/api/mis-prestamos', auth, async (req, res) => {
  res.json(await prisma.prestamo.findMany({
    where: { usuarioId: req.usuario.id }, include: { material: true }, orderBy: { fechaSolicitud: 'desc' },
  }));
});

// ---------- Administración ----------
app.get('/api/admin/prestamos', auth, soloAdmin, async (req, res) => {
  res.json(await prisma.prestamo.findMany({
    include: { material: true, usuario: { select: { nombre: true, matricula: true, rol: true } } },
    orderBy: { fechaSolicitud: 'desc' },
  }));
});

app.get('/api/admin/vencidos', auth, soloAdmin, async (req, res) => {
  res.json(await prisma.prestamo.findMany({
    where: { estado: 'ENTREGADO', fechaDevolucion: { lt: new Date() } },
    include: { material: true, usuario: { select: { nombre: true, matricula: true } } },
  }));
});

app.post('/api/admin/prestamos/:id/entregar', auth, soloAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const p = await prisma.prestamo.findUnique({ where: { id } });
  if (!p || p.estado !== 'PENDIENTE') return res.status(409).json({ error: 'Solo se pueden entregar solicitudes pendientes.' });
  const { condicion = 'BUENO', notas = '' } = req.body || {};
  await prisma.prestamo.update({
    where: { id },
    data: { estado: 'ENTREGADO', fechaEntrega: new Date(), condicionEntrega: condicion, notasEntrega: notas },
  });
  res.json({ mensaje: 'Material entregado y registrado en el historial.' });
});

app.post('/api/admin/prestamos/:id/rechazar', auth, soloAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const p = await prisma.prestamo.findUnique({ where: { id } });
  if (!p || p.estado !== 'PENDIENTE') return res.status(409).json({ error: 'Solo se pueden rechazar solicitudes pendientes.' });
  await prisma.prestamo.update({ where: { id }, data: { estado: 'RECHAZADO' } });
  res.json({ mensaje: 'Solicitud rechazada.' });
});

app.post('/api/admin/prestamos/:id/devolver', auth, soloAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const p = await prisma.prestamo.findUnique({ where: { id } });
  if (!p || p.estado !== 'ENTREGADO') return res.status(409).json({ error: 'Solo se pueden devolver préstamos entregados.' });
  const { condicion = 'BUENO', notas = '' } = req.body || {};
  const ops = [
    prisma.prestamo.update({
      where: { id },
      data: { estado: 'DEVUELTO', fechaDevuelto: new Date(), condicionDevuelto: condicion, notasDevuelto: notas },
    }),
  ];
  if (condicion === 'DANADO') ops.push(prisma.material.update({ where: { id: p.materialId }, data: { estado: 'MANTENIMIENTO' } }));
  await prisma.$transaction(ops);
  res.json({ mensaje: condicion === 'DANADO' ? 'Devuelto como dañado: el material pasó a mantenimiento.' : 'Devolución registrada.' });
});

app.post('/api/admin/materiales', auth, soloAdmin, async (req, res) => {
  const { nombre, cantidadTotal } = req.body || {};
  const cant = Number(cantidadTotal);
  if (!nombre || !String(nombre).trim() || !Number.isInteger(cant) || cant < 1)
    return res.status(400).json({ error: 'Indica un nombre y una cantidad válida.' });
  const m = await prisma.material.create({ data: { nombre: String(nombre).trim(), cantidadTotal: cant } });
  res.status(201).json(m);
});

app.post('/api/admin/materiales/:id/baja', auth, soloAdmin, async (req, res) => {
  await prisma.material.update({ where: { id: Number(req.params.id) }, data: { estado: 'BAJA' } });
  res.json({ mensaje: 'Material dado de baja.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CIMA en http://localhost:${PORT}`));
