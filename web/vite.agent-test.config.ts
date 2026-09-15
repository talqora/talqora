// 临时联调配置(未跟踪文件;不需要时删除即可):
// 跳过 vite-plugin-mkcert —— 该插件启动时需访问 GitHub 校验/下载 mkcert 二进制,
// 当前网络返回 403 导致 `pnpm start` 起不来。本配置改用 HTTP 起 dev server
// (our-chat 的 CLIENT_ORIGINS 已包含 http://localhost:5173)。
// 正式修法(如需 HTTPS): 给 vite.config.ts 的 mkcert() 传本地二进制路径
//   mkcertOptions = { mkcertPath: '/opt/homebrew/bin/mkcert' }
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3007', changeOrigin: true },
      '/oauth': { target: 'http://127.0.0.1:3007', changeOrigin: true },
      '/user': { target: 'http://127.0.0.1:3007', changeOrigin: true },
      '/socket.io': { target: 'http://127.0.0.1:3007', ws: true, changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/style/tokens.scss" as *;`,
      },
    },
  },
})
