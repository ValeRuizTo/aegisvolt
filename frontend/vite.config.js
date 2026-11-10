import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Rutas RELATIVAS a los archivos compilados: la aplicacion se sirve detras
  // del API Gateway bajo un prefijo distinto por ambiente
  // (/execute-api/aegisvolt-dev/dev/, .../aegisvolt-prod/prod/, ...).
  base: './',
  server: {
    port: 5173,
    // En desarrollo local, /graphql se reenvia al gateway (VITE_GRAPHQL_TARGET).
    proxy: {
      '/graphql': process.env.VITE_GRAPHQL_TARGET ?? 'http://localhost:3000',
    },
  },
});
