const express = require('express');
const bcrypt = require('bcryptjs');
const {
  prisma,
  asyncHandler,
  fail,
  transaction,
  audit,
  eligibility,
  config,
  ZONE,
  now,
} = require('../lib/core');
const { auth, issueToken, publicUser, validatePassword } = require('../lib/auth');
const router = express.Router();
const domain = (process.env.DOMINIO_INSTITUCIONAL || 'uabc.edu.mx').toLowerCase();
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Limita ataques incluso contra identificadores inexistentes, sin revelar si la cuenta existe.
const attempts = new Map();
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { identificador, correo, matricula, password } = req.body || {};
    const value = identificador || correo || matricula;
    if (
      typeof value !== 'string' ||
      typeof password !== 'string' ||
      !value.trim() ||
      value.length > 254 ||
      Buffer.byteLength(password) > 72
    )
      fail(400, 'Escribe tu matrícula o correo y tu contraseña.');
    const key = req.ip;
    const record = attempts.get(key);
    if (record && record.until > Date.now() && record.count >= 60)
      fail(429, 'Se alcanzó el límite de intentos. Espera cinco minutos.');
    attempts.set(key, {
      count: record && record.until > Date.now() ? record.count + 1 : 1,
      until: record && record.until > Date.now() ? record.until : Date.now() + 300000,
    });
    if (attempts.size > 5000)
      for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
    const identifier = value.trim().toLowerCase();
    const u = await prisma.usuario.findFirst({
      where: {
        OR: [{ correo: identifier }, { matricula: { equals: identifier, mode: 'insensitive' } }],
      },
    });
    if (!u) {
      await bcrypt.compare(
        password,
        '$2a$10$K23PqxXui1.5Zr9XQ1r1eeubY9gUlzH6cTVq5UbODmCxQvVx3iqy6',
      );
      fail(401, 'Matrícula, correo o contraseña incorrectos.');
    }
    if (u.bloqueadoHasta && u.bloqueadoHasta > now())
      fail(423, 'Cuenta bloqueada temporalmente. Intenta de nuevo en cinco minutos.');
    const ok = await bcrypt.compare(password, u.passwordHash);
    if (!ok) {
      await transaction(async (tx) => {
        const current = await tx.usuario.findUnique({ where: { id: u.id } });
        if (current.bloqueadoHasta && current.bloqueadoHasta > now()) return;
        const count = current.intentos + 1;
        await tx.usuario.update({
          where: { id: u.id },
          data: {
            intentos: count >= 5 ? 0 : count,
            bloqueadoHasta: count >= 5 ? new Date(Date.now() + 300000) : null,
          },
        });
      });
      fail(401, 'Matrícula, correo o contraseña incorrectos.');
    }
    const current = await transaction(async (tx) => {
      const user = await tx.usuario.findUnique({ where: { id: u.id } });
      if (user.passwordHash !== u.passwordHash)
        fail(401, 'Las credenciales cambiaron. Inicia sesión nuevamente.');
      if (user.bloqueadoHasta && user.bloqueadoHasta > now())
        fail(423, 'Cuenta bloqueada temporalmente. Intenta de nuevo en cinco minutos.');
      if (!user.activo) fail(403, 'Tu cuenta está inactiva. Contacta al administrador.');
      if (['ALUMNO', 'DOCENTE'].includes(user.rol)) {
        const p = await tx.padron.findFirst({
          where: { matricula: { equals: user.matricula, mode: 'insensitive' } },
        });
        if (!p?.activo) fail(403, 'Tu matrícula no está activa en el padrón del periodo.');
      }
      return tx.usuario.update({
        where: { id: u.id },
        data: { intentos: 0, bloqueadoHasta: null },
      });
    });
    res.json({
      token: issueToken(current),
      usuario: publicUser(current),
      elegibilidad: await eligibility(prisma, current.id),
    });
  }),
);
// Compatibilidad con cuentas del padrón previo. Los alumnos importados ya tienen cuenta.
router.post(
  '/registro',
  asyncHandler(async (req, res) => {
    const { matricula, correo, password } = req.body || {};
    if (
      typeof matricula !== 'string' ||
      !matricula.trim() ||
      matricula.length > 80 ||
      typeof correo !== 'string' ||
      correo.length > 254
    )
      fail(400, 'Indica matrícula, correo institucional y contraseña.');
    const mail = correo.trim().toLowerCase();
    if (!emailRe.test(mail) || !mail.endsWith('@' + domain))
      fail(400, `Usa un correo institucional válido (@${domain}).`);
    validatePassword(password);
    const hash = await bcrypt.hash(password, 12);
    await transaction(async (tx) => {
      const p = await tx.padron.findFirst({
        where: { matricula: { equals: matricula.trim(), mode: 'insensitive' } },
      });
      if (!p?.activo || !['ALUMNO', 'DOCENTE'].includes(p.rol))
        fail(403, 'La matrícula no está activa en el padrón.');
      if (p.correo && p.correo.toLowerCase() !== mail)
        fail(403, 'Los datos no coinciden con el padrón institucional.');
      const exists = await tx.usuario.findFirst({
        where: {
          OR: [{ matricula: { equals: p.matricula, mode: 'insensitive' } }, { correo: mail }],
        },
      });
      if (exists)
        fail(
          409,
          'Ya existe una cuenta con esa matrícula o correo. Usa las credenciales proporcionadas por el administrador.',
        );
      const u = await tx.usuario.create({
        data: {
          matricula: p.matricula,
          nombre: p.nombre,
          correo: mail,
          passwordHash: hash,
          rol: p.rol,
          carrera: p.carrera,
          periodo: p.periodo,
        },
      });
      await audit(tx, u, 'REGISTRO_CUENTA', 'USUARIOS', { usuarioId: u.id });
    });
    res.status(201).json({ mensaje: 'Cuenta creada. Ya puedes iniciar sesión.' });
  }),
);
router.get(
  '/mi-cuenta',
  auth,
  asyncHandler(async (req, res) => {
    const [elegibilidad, convenios, adeudos] = await Promise.all([
      eligibility(prisma, req.usuario.id),
      prisma.convenio.findMany({
        where: { usuarioId: req.usuario.id },
        include: {
          adeudo: {
            include: {
              incidencia: {
                include: { piezaPrestamo: { include: { pieza: { include: { material: true } } } } },
              },
            },
          },
        },
        orderBy: { fechaCreacion: 'desc' },
      }),
      prisma.adeudo.findMany({
        where: { usuarioId: req.usuario.id },
        include: {
          incidencia: {
            include: { piezaPrestamo: { include: { pieza: { include: { material: true } } } } },
          },
          convenios: true,
        },
        orderBy: { creadoEn: 'desc' },
      }),
    ]);
    res.json({ usuario: req.usuario, elegibilidad, convenios, adeudos });
  }),
);
router.get(
  '/reglas',
  auth,
  asyncHandler(async (req, res) =>
    res.json({
      configuracion: await config(),
      zonaHoraria: ZONE,
      horaServidor: now(),
      usoInterno:
        'El material es de uso exclusivo dentro de la Facultad de Ciencias Químicas e Ingeniería y no puede salir del plantel.',
    }),
  ),
);
router.post(
  '/password',
  auth,
  asyncHandler(async (req, res) => {
    const { passwordActual, passwordNuevo } = req.body || {};
    if (typeof passwordActual !== 'string' || Buffer.byteLength(passwordActual) > 72)
      fail(400, 'Escribe tu contraseña actual.');
    validatePassword(passwordNuevo);
    const u = await prisma.usuario.findUnique({ where: { id: req.usuario.id } });
    if (!(await bcrypt.compare(passwordActual, u.passwordHash)))
      fail(400, 'La contraseña actual no es correcta.');
    if (passwordActual === passwordNuevo)
      fail(400, 'La contraseña nueva debe ser distinta de la temporal o anterior.');
    const hash = await bcrypt.hash(passwordNuevo, 12);
    const updated = await transaction(async (tx) => {
      const result = await tx.usuario.updateMany({
        where: { id: u.id, passwordHash: u.passwordHash },
        data: { passwordHash: hash, debeCambiarPassword: false, sessionVersion: { increment: 1 } },
      });
      if (result.count !== 1)
        fail(409, 'La contraseña cambió durante la operación. Vuelve a iniciar sesión.');
      await audit(tx, req.usuario, 'CAMBIO_PASSWORD', 'USUARIOS', { usuarioId: u.id });
      return tx.usuario.findUnique({ where: { id: u.id } });
    });
    res.json({
      mensaje: 'Contraseña actualizada.',
      token: issueToken(updated),
      usuario: publicUser(updated),
    });
  }),
);
router.post(
  '/logout',
  auth,
  asyncHandler(async (req, res) => {
    await prisma.usuario.update({
      where: { id: req.usuario.id },
      data: { sessionVersion: { increment: 1 } },
    });
    res.json({ mensaje: 'Sesión cerrada.' });
  }),
);
module.exports = router;
