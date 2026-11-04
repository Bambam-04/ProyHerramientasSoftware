# CIMA — Cómo ejecutar el sistema

## Requisitos

- Node.js 18 o superior
- PostgreSQL, con una base de datos vacía llamada `cima`

## Pasos

1. Copia `.env.example` como `.env` y escribe la contraseña de PostgreSQL en `DATABASE_URL`:

```
DATABASE_URL="postgresql://postgres:TU_CONTRASEÑA@localhost:5432/cima"
```

2. En la carpeta del proyecto ejecuta:

```
npm install
npx prisma db push
npm run db:seed
npm start
```

3. Abre http://localhost:3000 en el navegador.

Para detener el sistema usa `Ctrl + C`. La próxima vez solo necesitas `npm start`.
