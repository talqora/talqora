import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import mkcert from 'vite-plugin-mkcert'
import path from 'path' // 注： Vite 配置文件在 Node.js 环境下运行，依赖需安装 @types/node，确保TypeScript识别 path 模块的类型声明
import fs from 'fs'
// https://vite.dev/config/

// Windows 经 WinGet 安装 mkcert 的固定路径。仅当它确实存在时才显式指定，
// 否则（macOS/Linux，或未装在该位置）交给插件自行定位/下载 mkcert，保证跨平台都能起 HTTPS dev。
const winMkcertPath = path.join(
  process.env.LOCALAPPDATA || '',
  'Microsoft',
  'WinGet',
  'Packages',
  'FiloSottile.mkcert_Microsoft.Winget.Source_8wekyb3d8bbwe',
  'mkcert.exe'
)
const mkcertOptions = fs.existsSync(winMkcertPath) ? { mkcertPath: winMkcertPath } : {}

// 用函数形式拿到 command:仅在生产构建(vite build)时移除 console/debugger,
// 开发(vite serve)时保留,不影响本地调试。
export default defineConfig(({ command }) => ({
  // esbuild 既是 Vite 的转译器也是默认压缩器,drop 会在压缩阶段静态删除这些语句
  esbuild: {
    drop: command === 'build' ? ['console', 'debugger'] : [],
  },
  plugins: [
    react(),
    mkcert(mkcertOptions),
  ],
  server: {
    host: '0.0.0.0',
    // 开发 HTTPS：使用系统已安装的 mkcert 生成并安装本地开发 CA，浏览器与局域网设备更容易信任证书。
    // ── Dev proxy 仅给"必须同源"的服务用 ──
    // our-chat 后端走 HttpOnly cookie 鉴权,浏览器要带 cookie 必须同源,故必须 proxy。
    // agent-server 用 Bearer header 鉴权,无 cookie 同源约束,前端直接打 + 后端 CORS
    // 白名单是更标准的做法,见 src/views/agentView/api.ts 与 docs。
    proxy: {
      // 网关作为唯一对外入口(26-9-16 演进方案 P3):HTTP API 与 WS 全部经 gateway:8090。
      // gateway 再反代 /api、/user、/oauth 到 server(3007 已内网化,仅回滚时直连)。
      '/api': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
      // /oauth/agent-token 走 our-chat 会话 cookie 鉴权,必须同源,故 proxy 到后端。
      '/oauth': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
      '/user': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
      // 实时路径已切到 Go gateway:原生 WS 走 /ws → gateway:8090(保留 /socket.io 供回滚)。
      '/ws': {
        target: 'http://127.0.0.1:8090',
        ws: true,
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://127.0.0.1:3007',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // 让每个 *.scss / *.module.scss 自动可见 tokens.scss 里的 SCSS 变量,
  // 模块文件直接写 $space-4 / $brand-wechat 即可,无需各自 @use。
  // 仅前置 @use 不会产出 CSS,所以零打包代价。
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/style/tokens.scss" as *;`,
      },
    },
  },
}))
