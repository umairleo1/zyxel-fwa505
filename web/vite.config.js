import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Share PORT with the server via the repo-root .env.
  const env = { ...loadEnv(mode, '..', ''), ...process.env };
  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Keep the browser's Host header: the server's CSRF guard compares it with Origin,
      // and the shorthand form (changeOrigin: true) makes every POST look cross-site.
      proxy: { '/api': { target: `http://127.0.0.1:${env.PORT || 4400}`, changeOrigin: false } },
    },
  };
});
