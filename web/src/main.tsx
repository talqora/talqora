import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// 注：以下样式引入顺序不可更改
import './assets/iconFonts/iconfont.css' // 阿里图标
import 'antd/dist/reset.css'// Ant Design
import './style/global.scss' // 全局 :root CSS vars + reset(替代原 index.css)
// 注意这个的引入必须在阿里图标后面，确保APP内所有对iconfont属性的修改能覆盖默认值，而不是被覆盖导致失效
import '@/i18n' // i18next 单例初始化(必须在 App 渲染前)
import App from './App.tsx'
import { initWebVitals } from './rum'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// 启动真实用户性能监控（field 数据采集）
initWebVitals()
