import { createBrowserRouter, Navigate } from "react-router-dom";
import type { ComponentType } from "react";
// 鉴权守卫：同步导入。它是进入受保护路由前的同步关卡,体积很小,
// 不参与懒加载,以免守卫本身也要等一次网络往返。
import RequireAuth from "@/utils/requireAuth";

// 把动态 import 的模块默认导出包装成 React Router 的 lazy 路由模块
const lazyComponent =
    (loader: () => Promise<{ default: ComponentType }>) =>
    async () => ({ Component: (await loader()).default });

// 开发调试中心：仅在开发构建中注册。
// import.meta.env.DEV 在生产构建会被替换为字面量 false，整个分支连同其动态 import
// 都会被 Rollup tree-shaking 移除——调试页根本不会进入生产产物，也就不可达。
// 这比「运行时鉴权」更强：前端运行时检查可被绕过，而这里的代码压根没被发布。
const devOnlyRoutes = import.meta.env.DEV
    ? [
          {
              path: "debug",
              lazy: lazyComponent(() => import("@/views/debug")),
              children: [
                  {
                      index: true,
                      lazy: lazyComponent(() => import("@/views/debug/home")),
                  },
                  {
                      path: "upload",
                      lazy: lazyComponent(() => import("@/views/debug/uploadDemo")),
                  },
              ],
          },
      ]
    : [];

const router = createBrowserRouter([
    // 一级路由首页：懒加载 Layout,但仍用同步的 RequireAuth 包裹做加载前鉴权。
    // 路由级 lazy 由 React Router 在导航时 await,组件就绪后才渲染,无需额外 Suspense。
    {
        path: "",
        lazy: async () => {
            const { default: Layout } = await import("@/views/layout/index.tsx");
            return {
                Component: () => (
                    <RequireAuth>
                        <Layout />
                    </RequireAuth>
                ),
            };
        },
        // 二级路由
        children: [
            { //默认重定向
                index: true,
                element: <Navigate to="/chat" replace/>
            },
            {
                // 可选参数:/chat 显示会话列表,/chat/:conversationId 进入具体会话。
                // 选中态进入 URL,浏览器/移动端硬件返回天然可用(单屏列表↔详情)。
                path: "chat/:conversationId?",
                lazy: lazyComponent(() => import("@/views/chatView/index.tsx")),
            },
            {
                path: "directory",
                lazy: lazyComponent(() => import("@/views/directoryView/index.tsx")),
            },
            {
                path: "agent",
                lazy: lazyComponent(() => import("@/views/agentView/index.tsx")),
            },
            {
                // 移动端「我」个人中心(底部 Tab);桌面端不展示该 Tab,但直链可达。
                path: "me",
                lazy: lazyComponent(() => import("@/views/meView/index.tsx")),
            }
        ]
    },
    // 一级路由登录
    {
        path: "auth",
        lazy: lazyComponent(() => import("@/views/authView/index.tsx")),
    },

    // 开发调试路由（生产构建中为空数组，被静态消除）
    ...devOnlyRoutes
]);

export default router;