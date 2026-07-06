# web 端前端架构——组织即运行时:为何"目录组织"是功能问题而非视觉问题

> 读者:做架构决策的资深前端/全栈工程师。
> 这是 iOS 端《模块化架构(Modular Monolith)——为何"目录组织"是功能问题》的**姊妹篇**。同一命题在 web 上**结论相同(组织决定能力,不只是视觉),但机制迥异**:
> - iOS 靠**编译器**硬守边界;**web 默认几乎不守**,要靠 monorepo/lint/构建工具外挂。
> - 而 web 多了一层 iOS 没有的东西——**组织直接砸到运行时**(bundle 体积、首屏、代码分割),且本项目**有 CI 门禁在量它**(Lighthouse + 体积预算)。所以在 web 上,"组织即功能"这句话**比 iOS 还硬**。
> 结论先行:本项目 `web/` 当前"单包 + 分层目录"对现体量**合理**;但有三件事**不用等模块化、现在就该做**(第 8 章),因为它们直接影响运行时与 CI 门禁。

---

## 0. TL;DR

- **JS/TS 的 module 是"每个文件"**,`import`/`export` 是文件级;**语言层面没有 `internal`/包私有**这种东西——任何文件都能 `import` 任何路径。所以"文件夹只是视觉、边界不强制"在 web 上**比 iOS 还成立**。
- 想要"边界被强制",web 得**外挂**:monorepo 包(pnpm workspaces / Nx / Turborepo)+ `package.json "exports"` + ESLint 边界规则 + TS project references。且多数是 **lint/CI 期(软约束)**,不是编译期(硬)。
- web 独有、且最"功能性"的差异:**tree-shaking / code-splitting / bundle 体积 / 循环导入静默崩** —— 组织烂**直接**让首屏变慢、CI 体积预算变红。iOS 单 module 里烂目录运行时零成本;**web 不是**。
- 现状:`web/` 是单包、分层目录(`globalApi`=Services、`globalType`=Models、`globalComponents`=DesignSystem、`views`=Features、`store`=RTK 全局态),**无 workspaces、无边界 lint、无 `exports` 封装**——边界纯靠自觉。

---

## 1. 术语表

| 术语 | 全称 / 展开 | 通俗解释 |
|---|---|---|
| ESM / CJS | ECMAScript Modules / CommonJS | JS 的两套模块系统。ESM 的静态 `import/export` 是 tree-shaking 的前提。 |
| Tree-shaking | 摇树 | 打包时**静态分析**删掉没被用到的导出。依赖 ESM 静态结构 + `sideEffects` 标注;**barrel 文件会破坏它**。 |
| Code-splitting / Lazy loading | 代码分割 / 懒加载 | 用**动态 `import()`** 把代码切成按需加载的 chunk(如 `React.lazy`)。 |
| Barrel file | 桶文件 | 一个 `index.ts` 把整个目录的东西 `export *` 再导出。方便,但**常常毁掉 tree-shaking 并制造循环依赖**。 |
| Monorepo / Workspaces | 单仓多包 | 一个仓库多个 npm 包(pnpm workspaces / Yarn workspaces)。web 版"模块化"的载体。 |
| Nx / Turborepo | — | monorepo 编排工具:项目依赖图、**affected-only 构建 + 缓存**、**强制模块边界**(Nx `enforce-module-boundaries`)。 |
| `exports`(package.json) | 包导出映射 | Node/打包器**只允许**外部 import 这里声明的入口;是 web 版的 `public` 边界。 |
| TS project references | TypeScript 项目引用 | `composite` + `references`,做**增量类型检查**与子项目边界。 |
| Module Federation | 模块联邦 | 运行时加载"远程"模块 = **微前端**;web 版的"跨可执行体复用/独立部署"。 |
| RTK (slice) | Redux Toolkit | React 的集中式状态。`createSlice` 按域切片;全局 `store` 若滥用会成耦合枢纽。 |
| DIP / Hexagonal | 依赖倒置 / 六边形 | 见姊妹篇。web 里表现为"接口 + 具体实现分离 + 注入"。 |

---

## 2. 背景:本项目 `web/` 的现状

栈:React + Redux Toolkit + antd + socket.io-client + i18next + **Vite**(单页应用 / CSR)。目录:

```
src/
  globalApi/         各 API client        ← 对应 iOS Services
  globalType/        共享类型/模型         ← 对应 iOS Models
  globalComponents/  ~20 个共享组件        ← 对应 iOS DesignSystem
  store/             Redux Toolkit 全局态
  views/             页面/功能:agentView · chatView · meView · settingView · authView · directoryView · layout
  router/ hooks/ utils/ i18n/ locales/ contracts/(openapi 生成)
```

实测边界工具**全无**:无 `workspaces`、无 Nx/Turborepo、**无 ESLint import 边界规则**、`package.json` **无 `exports` 封装**。`tsconfig.json` 里的 `references` 只是 Vite 标准的 app/node 拆分,**不是功能边界**。

即:和 iOS 单 target 一样是"**单构建单元 + 分层文件夹 + 边界零强制**"。方向对(与业界 IceCubesApp 的 `Models`/`NetworkClient`/`DesignSystem` 划分同构),但都还是文件夹。

**已有的 CI 门禁(关键)**:`web/lighthouserc.cjs` + CI `perf.yml` 对改动 `web/` 的 PR 跑 **体积预算 + Lighthouse**。这意味着——**bundle 体积/首屏是被机器量化、会卡 PR 的**。记住这条,第 5.3 反复用。

---

## 3. 核心事实:web 的"模块"是什么,"文件夹"是什么

- **web 的 module = 单个文件**(ESM)。`import x from './a'` 里的 `./a` 就是一个 module。粒度比 Swift 的"一个 target 一个 module"**细得多**。
- **文件夹 / 路径别名(`@/...`)对边界零贡献**:`views/meView` 里的文件能**直接** `import` `views/chatView` 里任何文件、能 import `globalApi` 任何内部件——**不需要声明、没人拦**。
- **且 JS/TS 没有"包私有(internal)"**:Swift 单 module 好歹有 `public` 的概念(升成模块后 `internal` 就真封了);**JS 语言层面连这层都没有**——一个文件 `export` 了,全项目(乃至若发布成包,全世界)都能 import。想"只在本功能内可见",语言帮不了你。

**推论**:在单包 web 项目里,目录组织对**构建产物的边界**同样近似"纯视觉"——但**注意**,它对**构建产物的形状(哪些代码进哪个 chunk、进不进 bundle)不是纯视觉**(第 5.3)。这正是 web 与 iOS 的分水岭。

---

## 4. 为什么是功能差异,不是视觉差异(核心章节)

### 4.1 边界强制:web 默认零强制(比 iOS 还弱),且循环导入会"静默崩"

- **封装**:如上,JS 无 `internal`。要拿到"跨功能乱伸手编译期报错",web 必须外挂:
  - **monorepo 包 + `package.json "exports"`**:把 `chat` 拆成包,只在 `exports` 里暴露入口 → 外部**深 import 内部件直接解析失败**。这是 web 唯一接近"硬边界"的手段。
  - **ESLint 边界规则**(`import/no-restricted-paths`、`eslint-plugin-boundaries`、Nx `enforce-module-boundaries`):在 **lint/CI 期**拦"views 互相 import 内部件"。软,但零运行时成本、易落地。
- **循环依赖——web 比 iOS 危险**:
  - iOS/SPM:模块间成环**直接编译失败**。
  - JS/ESM:**允许成环**,且常在**运行时静默出错**——环中某个 binding 在被引用时尚未初始化(TDZ/live-binding),得到 `undefined` 或抛错,表现为"莫名其妙 A 页面偶发白屏"。**barrel 桶文件是循环依赖的重灾区**。
  - 对策必须外挂:ESLint `import/no-cycle`、`madge --circular` / `dpdm`。
  → **功能差异**:同一个"防环"能力,iOS 编译器白送;web 不配工具就是**运行时 heisenbug**。

### 4.2 依赖倒置 / 可换实现 / 测试隔离(与 iOS 同理)

- web 的 DI:用 TS `interface` 定接口,具体实现通过工厂/Context/参数注入。把 `ChatApi`(接口)与其 `live`(fetch/socket 实现)分开,好处同 iOS:
  - **测试**:vitest 里注入 mock,**不拉起真实网络/socket**;
  - **可换实现**:Demo/离线构建注入假数据实现,页面代码不改;
  - **打包收益**:接口与实现分离 + 动态 import,让"重实现"(如 socket.io、agent SSE 流)**不进初始 bundle**。
- 但注意 web 特有陷阱:**TS 类型运行时被擦除**——"依赖接口不依赖实现"若只靠类型,运行时其实还是 import 了具体文件。真正的运行时隔离要靠**动态 `import()` / 包 `exports` 边界**,不能只靠 `interface`。

### 4.3 运行时维度:tree-shaking / code-splitting / bundle 体积(web 独有,最硬)

**这是 web 与 iOS 最大的不同,也是"组织即功能"在 web 上最硬的证据。** iOS 单 module 里烂目录运行时零成本;web 的组织**直接决定浏览器下载和执行多少代码**:

1. **Tree-shaking 被组织方式左右**:
   - 一个 `globalComponents/index.ts` 把 20 个组件 `export *`(barrel),使用方 `import { Button } from '@/globalComponents'` 时,**打包器很难确定其余 19 个及其副作用能否删**,常常**整包打进 bundle** → 发死代码。
   - 组织成"**深路径直引 + `sideEffects:false`**"(`import Button from '@/globalComponents/button'`)则摇得干净。
   - → 组织方式 = **发多少字节** = 首屏快慢 = **CI 体积预算过不过**。
2. **Code-splitting 需要按功能组织**:
   - 用 `React.lazy(() => import('@/views/agentView'))` 把 agent/通话这类重模块切成**按需 chunk**;组织乱、互相纠缠就**切不干净**,全塞初始包。
   - 我们的 `agentView`(7 文件,含 SSE 流)、`globalComponents/callModal`(3 文件,含 WebRTC)、`cropperModal`(图片裁剪库)都是**典型该懒加载**的重家伙。
3. **有 CI 在量**:`perf.yml` 跑体积预算 + Lighthouse。**组织烂 → bundle 超预算 → PR 红**。这不是审美,是**门禁级的功能约束**。

一句话:**在 web 上,"目录/依赖组织"是 bundle 形状的一部分,而 bundle 形状是产品性能的一部分。** 这层因果 iOS 单 module 根本没有。

### 4.4 复用到"第二个前端" / 微前端

- web 版的"复用到 Extension/Widget" = **一个仓库里多个 app/入口**:主站 + 后台 admin + 落地页 + 浏览器扩展 + 发布到 npm 的组件库。要跨它们复用 `globalComponents`/`globalType`/`globalApi`,得是**真包**,不能是某个 app 里的文件夹。
- 更进一步:**Module Federation(微前端)**——运行时拼装独立构建、独立部署的前端。对应 iOS 的"独立可执行体",是"组织决定能否独立部署一块前端"的极端形态。

### 4.5 增量 / affected 构建 + Redux 全局态耦合

- **构建速度**:Nx/Turborepo 按项目图做 **affected-only 构建 + 远程缓存**——只重建被影响的包。单包 Vite 项目改一行,类型检查/构建仍是整体。
- **web 特有耦合枢纽:Redux 全局 `store/`**。所有 view 都往同一个全局 store 伸手,本身就是**跨功能耦合点**。现代做法是 **RTK slice 按 feature 就近拆**(feature-scoped state + `store.injectReducer` 动态注入),否则 `store/` 会长成一个谁都依赖、谁都改的上帝对象——**这是分层目录看不出、但真实存在的耦合**。

### 小结:web vs iOS 一张表

| 维度 | iOS(Swift/SPM) | web(TS/打包器) |
|---|---|---|
| 边界强制 | 编译器原生(module+access control),**硬** | 无原生;靠 monorepo+`exports`+lint,**多为软(CI 期)** |
| 循环依赖 | 编译失败 | **运行时静默崩**,须 `import/no-cycle`/`madge` |
| 组织影响运行时? | **否**(单 module 烂目录零运行成本) | **是**:tree-shaking/分包/体积 → 首屏 + CI 门禁 |
| 依赖倒置隔离 | 不链接 Live 模块 | 类型会被擦除,须动态 `import()`/包 `exports` 才真隔离 |
| 复用到第二产物 | Extension/Widget 链模块 | 多 app/入口 / 微前端 需真包 |
| 增量构建 | 模块级 | Nx/Turbo affected + 缓存 |

---

## 5. 代价与反面(诚实评估)

- **monorepo 有运维税**:workspaces/Nx/Turbo 的配置、包版本、CI 图维护;小项目上大炮打蚊子。
- **`exports` / 边界 lint 有摩擦**:深 import 被禁后,要认真设计每个包的公共面;初期会频繁"为什么 import 不到"。
- **过度分包反噬**:切太碎 → chunk 太多 → HTTP 请求瀑布 + 公共依赖重复,**首屏反而更慢**。code-splitting 要按"路由/交互边界"切,不是越碎越好。
- **SSR/RSC 不在此列**:我们是 Vite CSR SPA,以上以浏览器端 bundle 为主;若将来上 SSR,server/client 边界会再加一层。

---

## 6. 决策框架:什么时候该上 monorepo / 硬边界

| 信号 | 本项目现状 |
|---|---|
| 要做**第二个前端**(admin/扩展/组件库外发) | 暂无,但 IM 常见后台管理端 |
| **构建/类型检查已慢**、CI 时间长 | 单包 Vite,暂可接受 |
| 多人并行、边界常被踩穿 | 人少,暂不突出 |
| **首屏/体积已被 CI 卡** | **已有 Lighthouse+体积预算门禁**——运行时维度**现在就相关** |
| 功能重且异构(agent 流 / WebRTC / 裁剪) | **已有**:agentView、callModal、cropperModal 都重 |

**判断**:和 iOS 同结论——**单包分层现在够用,monorepo 是"长大了/要第二前端/构建变慢"再上**。但**运行时那三件事(4.3)现在就该做**,因为它们与 CI 门禁直接挂钩,且零架构成本。

---

## 7. 落到 `web/` 的建议

### 7.1 现在就做(零/低成本,直接影响运行时与 CI)
1. **别用大 barrel 桶文件**:`globalComponents`、`utils` 若有 `export *` 的 `index.ts`,改成深路径直引;`package.json` 加 `"sideEffects": false`(或精确列出有副作用的文件),让 tree-shaking 生效。
2. **按路由/重模块 code-splitting**:`React.lazy` + 动态 `import()` 懒加载 `agentView`、`callModal(WebRTC)`、`cropperModal`,把它们**移出初始 bundle**。
3. **`eslint.config.js` 加两条边界 lint**(我们用的是 flat config):
   - `import/no-cycle` —— 零成本拿到 iOS 靠编译器白送的"无环"保护;
   - `import/no-restricted-paths` 或 `eslint-plugin-boundaries` —— 禁止 `views/*` 互相 import 内部件、禁止 `globalApi` 反向 import `views`。
4. **量一下**:`npx madge --circular src` 看现有环;`vite build` 后看 chunk 体积,对齐体积预算。

### 7.2 将来要"真模块化"时的目标形态(对应 iOS 的 SPM 图)
```
packages/
  design-system   (globalComponents)     ← 可被主站/admin/扩展复用
  models          (globalType, contracts)
  api             (globalApi 接口)         ← 具体实现可拆 api-live,动态注入
  feature-chat / feature-agent / feature-me …   ← 各带自己的 RTK slice
apps/
  web             组合根:装配 features + 注入 api-live + Vite 构建
  (admin/…)       复用上面的 packages
```
- 工具:**pnpm workspaces + Turborepo/Nx**(affected 构建 + 缓存 + `enforce-module-boundaries`)。
- 每个包 `package.json "exports"` 定公共面;RTK **slice 随 feature 走**,`store` 只做动态注入的装配点。

### 7.3 渐进路径(低风险)
1. 先做 7.1 三件事(纯收益,不改架构)。
2. 抽 `design-system` / `models` 为独立包(无上游依赖,最先能被第二前端复用)。
3. `api` 拆接口/实现 + 动态注入。
4. 逐个 view 升为 feature 包(轻的 `settingView`/`directoryView` 先行验证)。
5. 每步 `pnpm build && vitest` + 看体积预算保持绿。

---

## 8. 附:速查

| 想要的能力 | iOS 怎么拿 | web 怎么拿 |
|---|---|---|
| 跨功能封装(禁止乱 import) | 分 module + `internal` | monorepo 包 + `exports` + ESLint 边界 |
| 禁循环依赖 | SPM 编译失败 | `import/no-cycle` / madge |
| 换实现 / 测试隔离 | 接口/Live 分模块 | interface + 动态 `import()` + 包边界 |
| 少发代码 / 首屏快 | (无此维度) | tree-shaking + code-splitting(**web 独有**) |
| 复用到第二产物 | Extension/Widget 链模块 | 多 app + 包 / 微前端 |
| 增量构建 | 模块级 | Nx/Turbo affected + 缓存 |

---

## 9. 参考

- Dimillian, **IceCubesApp**(`Packages/` 下 `Models`/`NetworkClient`/`DesignSystem` + feature 包,web/Swift 通用的"共享包 + feature 包"范式):https://github.com/Dimillian/IceCubesApp
- **Nx** 强制模块边界(`@nx/enforce-module-boundaries`):https://nx.dev/features/enforce-module-boundaries
- **Turborepo**(affected 构建 + 缓存):https://turbo.build/repo
- Node.js **package `exports`**(包封装边界):https://nodejs.org/api/packages.html#exports
- **eslint-plugin-import**(`no-cycle` / `no-restricted-paths`):https://github.com/import-js/eslint-plugin-import
- 姊妹篇:《iOS 端模块化架构(Modular Monolith)——为何"目录组织"是功能问题》(本目录)
