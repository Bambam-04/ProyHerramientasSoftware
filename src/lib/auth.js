const jwt = require('jsonwebtoken');
const { prisma, asyncHandler, fail } = require('./core');
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === 'cambia-este-secreto')
  throw new Error('Configura JWT_SECRET con un secreto aleatorio antes de iniciar CIMA.');
function issueToken(usuario) {
  return jwt.sign({ id: usuario.id, version: usuario.sessionVersion }, SECRET, {
    expiresIn: process.env.SESSION_TTL || '2h',
    algorithm: 'HS256',
    issuer: 'cima',
    audience: 'cima-web',
  });
}
const publicUser = (u) => ({
  id: u.id,
  matricula: u.matricula,
  nombre: u.nombre,
  correo: u.correo,
  rol: u.rol,
  activo: u.activo,
  bloqueo: u.bloqueo,
  carrera: u.carrera,
  periodo: u.periodo,
  fotografia: u.fotografia,
  debeCambiarPassword: u.debeCambiarPassword,
});
const auth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) fail(401, 'Inicia sesión para continuar.');
  let claims;
  try {
    claims = jwt.verify(header.slice(7), SECRET, {
      algorithms: ['HS256'],
      issuer: 'cima',
      audience: 'cima-web',
    });
  } catch {
    fail(401, 'Tu sesión terminó. Inicia sesión nuevamente.');
  }
  if (!Number.isSafeInteger(claims.id)) fail(401, 'La sesión no es válida.');
  const u = await prisma.usuario.findUnique({ where: { id: claims.id } });
  if (!u || claims.version !== u.sessionVersion)
    fail(401, 'Tu sesión terminó. Inicia sesión nuevamente.');
  if (!u.activo) fail(403, 'Tu cuenta se encuentra deshabilitada. Contacta al administrador.');
  if (['ALUMNO', 'DOCENTE'].includes(u.rol)) {
    const padron = await prisma.padron.findFirst({
      where: { matricula: { equals: u.matricula, mode: 'insensitive' } },
    });
    if (!padron?.activo) fail(403, 'Tu matrícula no está activa en el padrón del periodo.');
  }
  req.usuario = publicUser(u);
  // Las credenciales temporales permiten únicamente cambiar la contraseña y consultar la cuenta.
  if (
    u.debeCambiarPassword &&
    !['/api/password', '/api/mi-cuenta', '/api/reglas', '/api/logout'].includes(
      req.originalUrl.split('?')[0],
    )
  )
    fail(403, 'Cambia tu contraseña temporal antes de continuar.');
  next();
});
const requireRoles =
  (...roles) =>
  (req, res, next) => {
    if (!roles.includes(req.usuario?.rol))
      return next(Object.assign(new Error('No tienes permiso para esta acción.'), { status: 403 }));
    next();
  };
function validatePassword(password) {
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    Buffer.byteLength(password, 'utf8') > 72 ||
    !/[A-Za-z]/.test(password) ||
    !/\d/.test(password)
  )
    fail(
      400,
      'La contraseña debe tener al menos 8 caracteres, letras y números, y no exceder 72 bytes.',
    );
}
module.exports = { auth, requireRoles, issueToken, publicUser, validatePassword };
