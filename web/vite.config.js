import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Share PORT with the server via the repo-root .env.
  const env = { ...loadEnv(mode, '..', ''), ...process.env };
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': `http://127.0.0.1:${env.PORT || 4400}` },
    },
  };
});
