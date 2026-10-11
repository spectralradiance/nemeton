import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.PORT ?? 5317),
    // When a launcher assigns a port, fail instead of silently moving to another one.
    strictPort: Boolean(process.env.PORT),
    proxy: { '/api': 'http://localhost:8787' },
  },
});
