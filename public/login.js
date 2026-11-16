'use strict';
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const boton = $('entrar');
  boton.disabled = true;
  mostrar('msg', '');
  try {
    const identificador = $('correo').value.trim();
    const data = await api('/api/login', {
      method: 'POST',
      sinRedirect: true,
      body: { identificador, correo: identificador, password: $('password').value },
    });
    guardarSesion(data);
    location.href = destino(data.usuario.rol);
  } catch (error) {
    mostrar('msg', error.message, 'error');
  } finally {
    boton.disabled = false;
  }
});
