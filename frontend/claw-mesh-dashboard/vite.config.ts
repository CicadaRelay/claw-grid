import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 18789,
    host: '0.0.0.0',
    proxy: {
      '/health': 'http://10.10.0.1:3002',
      '/tools': 'http://10.10.0.1:8080',
      '/api/governance': 'http://10.10.0.1:3004',
      '/api/mesh': 'http://10.10.0.1:3001',
      '/ws': {
        target: 'ws://10.10.0.1:3001',
        ws: true,
      },
      '/star-office': {
        target: 'http://43.163.225.27:18800',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/star-office/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // P1: 代码分割——核心 UI 优先加载，可视化懒加载
    rollupOptions: {
      output: {
        manualChunks: {
          'viz': ['reactflow'],
          'state': ['zustand', 'socket.io-client'],
        },
      },
    },
  },
})
