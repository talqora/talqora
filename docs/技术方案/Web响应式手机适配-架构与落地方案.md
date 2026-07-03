# Web 响应式手机适配 —— 架构与落地方案

> 范围:把 our-chat 的 **web 端**从「仅桌面布局」改造成**桌面 / 手机双形态**——手机窄屏(≤768px)呈现**手机微信式布局习惯**(底部 Tab 栏、单屏列表→详情、「我」个人中心页、弹窗全屏化)。本文讲清:为什么这么改、选什么架构、为什么这套架构是最佳实践、各页面/弹窗如何落地、验证到什么程度。
> 结论先行:采用 **「CSS 优先 + JS 逃生舱 + 单一断点源」的 Hybrid 架构**——表现层差异(尺寸/顺序/显隐/单屏)全部交给 CSS;只有 CSS 够不到的(antd `Modal` 的内联 `width`)才用一个 `useIsMobile()` hook;断点只有一个真相源(`$bp-md = 768px`),SCSS 与 JS 共用。信息架构上,移动端把**头像(资料)+ ☰ 菜单(设置/退出)合并进新增的 `/me` 个人中心页**,底部 4 Tab = 聊天 / 通讯录 / 智能体 / 我。桌面端**零回归**。

---

## 0. 术语表(先读)

| 术语 | 全称 / 含义 | 通俗解释 |
|---|---|---|
| **断点(breakpoint)** | — | 布局切换的临界宽度。本项目移动端临界 = `$bp-md` = 768px。 |
| **媒体查询(media query)** | `@media (max-width: …)` | CSS 按视口尺寸生效不同规则的机制,响应式的基石。 |
| **SCSS mixin** | `@mixin` / `@include` | SCSS 的「可复用规则块」。把 `@media (max-width:$bp-md){…}` 封成 `@include mobile{…}`,断点只写一处。 |
| **CSS 自定义属性** | `var(--x)` | 运行期变量,主题切换即换值。本项目浅/深色靠它。 |
| **`matchMedia`** | `window.matchMedia(query)` | 浏览器原生 API:用 JS 查询某媒体条件是否命中,并可监听变化。 |
| **`useSyncExternalStore`** | React 18+ Hook | 让组件**无撕裂(tear-free)、并发安全**地订阅「React 之外的状态源」(如 `matchMedia`)。 |
| **`dvh` / `vh`** | dynamic / static viewport height | `100vh` 在手机浏览器会把地址栏一起算进去导致底部被顶掉;`100dvh` 是「随浏览器 UI 伸缩的真实可视高度」。 |
| **安全区(safe area)** | `env(safe-area-inset-*)` | 刘海屏/底部 home 指示条占用的不可点区域。需 viewport meta 带 `viewport-fit=cover` 才生效。 |
| **master-detail / 单屏** | — | 「列表 + 详情」两栏布局;窄屏退化为单屏:先列表,点开进详情,返回回列表。 |
| **sheet / 全屏弹层** | — | 移动端弹窗惯例:不再是居中小卡片,而是铺满屏(全屏)或贴底升起(bottom sheet)。 |
| **antd `Modal` 的 `width`** | — | antd 弹窗宽度是写在 DOM 上的**内联 style**;内联样式优先级高,纯 CSS 媒体查询难干净覆盖。 |

---

## 1. 问题:为什么要做

现状审查(逐项核实):

1. **整套布局仅适配桌面**:`layout` 左侧 60px 竖向导航栏 + 主区左右分栏,窄屏直接挤爆;十几个 `.module.scss` 里硬编码定宽(`settingView` 520px、`callModal` 420px、`profileCard` 300px、`agentView` 侧栏 180px…),手机上要么溢出要么不可用。
2. **导航 chrome 是桌面范式**:头像浮层、☰ 菜单都靠**绝对定位锚在竖栏旁**(`left: 56px/64px`),这在手机底部 Tab 形态下无处安放。
3. **弹窗是桌面小卡片范式**:`callModal`/`cropperModal` 用 antd `Modal` 定宽居中;`settingView` 是 520px 双栏浮层——都不符合手机「全屏/贴底」惯例。
4. **信息架构不符手机习惯**:手机微信把「头像资料 + 设置 + 退出」收进一个**「我」Tab**,而我们现在是头像、菜单各自悬浮的桌面布局。

**触发问题的根本**:首版只按桌面单形态设计,没有「双形态」的工程化机制(无共享断点、无 JS 侧的移动判定、无统一的移动模式)。

---

## 2. 目标与非目标

**目标(可测成功标准):**
- ≤768px:底部 4 Tab(聊天/通讯录/智能体/我),单屏列表↔详情,「我」页合并头像+设置+退出,**所有弹窗**全屏/近全宽化,关键热区 ≥44px。
- 桌面(>768px):**零回归**——所有改动收敛在 `@include mobile{}` 与移动专属路由内,桌面规则与 DOM 行为不变。
- 工程门禁:`tsc -b` 0、`eslint` 0、`vitest` 全绿、`vite build` 成功。

**非目标:** 不重写组件库、不引入新 UI 框架、不做平板专属断点(只做「手机 vs 桌面」单临界)、不改后端/契约。

---

## 3. 架构决策(核心)

### 3.1 原则:CSS 优先,JS 当逃生舱,断点单一真相源

**表现层差异交给 CSS;行为/结构差异才用 JS;断点只有一个。**

为什么不是「纯 CSS」也不是「纯 JS」,见 §3.5 对比。先讲清两条机制原理:

**为什么 CSS 够不到 antd `Modal`?**
antd `Modal` 把宽度渲染成 DOM 上的**内联 style**(`<div class="ant-modal" style="width:420px">`)。CSS 媒体查询要覆盖内联样式必须 `.ant-modal{width:100vw !important}` 且得精准命中 `wrapClassName`——既要 `!important` 又依赖 antd 内部类名,脆弱。**直接把 `width` 当 prop 按移动端传值**才是干净解。这就是「逃生舱」存在的唯一理由。

**为什么不纯 JS(`useIsMobile()` 条件渲染一切)?**
- 跨断点会触发**组件 remount**(卸载重挂),状态丢失、有闪烁;
- 每次 resize 都 re-render 整棵树,开销大;
- 首屏/未水合时 hook 尚未给出正确值,会先画错再跳变。
纯 JS 把本属 CSS 的表现差异硬塞进 JS,是反模式。

### 3.2 基础设施一:SCSS 断点 mixin(单一断点源 · CSS 侧)

加进 `src/style/tokens.scss`(已被 vite `additionalData: @use "@/style/tokens.scss" as *` **全局注入**,每个 `.scss` 自动可见):

```scss
@mixin mobile { @media (max-width: $bp-md) { @content; } } // ≤768
```

各文件一律 `@include mobile { … }`,**不再裸写 `@media`**。断点要改只动 `$bp-md` 一处;mixin 让「移动覆盖」在语义上自解释。(只做「手机 vs 桌面」单临界,桌面是默认态,无需 `desktop` mixin。)

### 3.3 基础设施二:`useIsMobile()` hook(单一断点源 · JS 侧)

`src/hooks/useIsMobile.ts`,用 `useSyncExternalStore` 订阅 `matchMedia`(与现有 `src/style/theme.tsx` 监听 `prefers-color-scheme` 同款范式,保持一致):

```ts
const MOBILE_MAX = 768; // 与 tokens.scss 的 $bp-md 同步(同一断点的两种宿主)
const QUERY = `(max-width: ${MOBILE_MAX}px)`;

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => { const m = matchMedia(QUERY); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); },
    () => matchMedia(QUERY).matches,
    () => false, // SSR/首屏快照:默认桌面
  );
}
```

`useSyncExternalStore` 保证并发渲染下读到的「是否移动」与实际 DOM **不撕裂**。
> 诚实说明:SCSS 的 `$bp-md` 与 TS 的 `MOBILE_MAX` 是同一断点在两种宿主语言里的副本,无法零成本编译期共享一个常量;以「注释强约束 + 单一数值 768」保证同步,这是该栈的通行做法。

### 3.4 每类问题落到哪一层(关键:不滥用 JS)

| 关注点 | 落到 | 原因 |
|---|---|---|
| 尺寸 / 间距 / 顺序 / 单屏列表↔详情 / 导航 chrome 显隐 | **CSS** `@include mobile` | 纯表现,无重渲染/闪烁,JS 未加载也正确 |
| antd `Modal` 宽度 / 全屏(`callModal`、`cropperModal`) | **JS** `useIsMobile()` 传 `width` | 内联 style,CSS 覆盖需 `!important` hack |
| 「我」页、底部 Tab、路由 | **路由** `/me` + `MeView` | 本就是路由制 app,深链/返回一致 |

### 3.5 方案对比(为何选 Hybrid)

| 维度 \ 方案 | 纯 CSS(每文件 `@media`) | 纯 JS(条件渲染一切) | **Hybrid(本方案)** | antd `Grid.useBreakpoint()` |
|---|---|---|---|---|
| antd Modal 适配 | ✗ 改不动内联 width | ✓ | ✓(hook 传 width) | ✓ |
| 重渲染 / 闪烁 | ✓ 无 | ✗ remount+闪烁 | ✓ 仅 antd 处少量 | ✗ 全量订阅 |
| 断点一致性 | △ 散落(靠变量缓解) | △ JS 内硬编码 | ✓ mixin + 常量单源 | ✗ 引入 antd 自有刻度(576/768/…)与本项目 token(640/768/1024)只 768 重合 |
| 未水合/首屏正确性 | ✓ | ✗ | ✓(CSS 兜底) | △ |
| 维护成本 | 低但易漂移 | 高 | 低(1 mixin + 1 hook) | 低但混两套断点 |

**选 Hybrid**:JS 用量最小、单一断点、无 remount,是 React + SCSS-modules + antd 这类栈的主流最佳实践。

### 3.6 移动端 Web 正确性(易漏的最佳实践)

- `.layout_container` 的 `height: 100vh` → **`100dvh`**(`100vh` 会被手机地址栏顶掉,底部 Tab 被遮)。
- 底部 Tab 加 `padding-bottom: env(safe-area-inset-bottom)`;**并给 viewport meta 补 `viewport-fit=cover`**——否则 `env()` 恒为 0,安全区不生效。
- viewport meta 的 `width=device-width, initial-scale=1` 已有。

---

## 4. 信息架构变化:底部 Tab + 「我」页

参考手机微信:底部 4 Tab,「我」页 = 头像资料区 + 功能行(本项目精简到 设置 / 退出登录)。

```
移动端(≤768px)                         桌面端(>768px,不变)
┌────────────────────┐                 ┌──┬───────────────────┐
│      内容区         │                 │头│                   │
│  (列表 / 详情单屏)  │                 │像│      内容区        │
│                    │                 │Tab│                   │
├────────────────────┤                 │ ⋮ │                   │
│ 聊天 通讯录 智能体 我│                 │☰ │                   │
└────────────────────┘                 └──┴───────────────────┘
                                         头像浮层/☰菜单 桌面专属
```

- 新增路由 `/me` → `MeView`:顶部头像 + 昵称 +「微信号(ID)」,下方「设置」「退出登录」两行。**「我」Tab 仅移动端显示**;桌面端头像/☰ 照旧、`/me` 不出现在导航(直链可达,无害)。
- **退出逻辑抽 `useLogout()` hook**,供桌面 ☰ 菜单与移动 `MeView` 复用(避免 12 行重复)。
- `SettingView` 仍是独立弹层组件:`MeView` 本地持有 `settingVisible` 自渲染一份,无需跨组件共享状态。

---

## 5. 各页面 / 弹窗落地矩阵

| 对象 | 当前(桌面) | 移动端策略 | 落到层 |
|---|---|---|---|
| `layout`(外壳) | 左 60px 竖栏 | 底部 fixed 横向 Tab(+「我」),头像/☰ 隐藏,`100dvh`+安全区 | CSS + 路由 |
| `chatView` | 列表 260 + 聊天 flex | 单屏:`/chat` 列表、`/chat/:id` 详情+返回(已做,回收成 mixin) | CSS(已路由化) |
| `directoryView` | 列表 200 + 详情 | 单屏 + 返回(已做,回收成 mixin) | CSS |
| `MeView`(新) | — | 个人中心页 | 路由 + CSS |
| `agentView` | 左 180px 侧栏 + 内容 | 侧栏 → 顶部横向 Tab 条,内容占满 | CSS |
| `settingView` | 520px 双栏浮层 | 全屏单列 sheet | CSS |
| `callModal` | antd Modal 420/400 居中 | 全屏:`width=100vw`,视频铺满 `100dvh`,PIP 重定位 | **JS**(width)+ CSS |
| `cropperModal` | antd Modal 400 | `width≈100vw`,裁剪区随屏 | **JS** + CSS |
| `fileUploader`(在 chatView 容器) | 270×340 居中 | 近全宽 / 贴底 | CSS |
| `addFriendModal` | fixed 250 顶部 | 近全宽居中 | CSS |
| `friendModal` | max 520、56px 内边距 | 缩内边距,占满单屏右栏 | CSS |
| `profileCard` | 固定 300 | 限宽 `min(300px, 92vw)` | CSS |
| `toast` | 居中无宽度上限 | 加 `max-width`,避免溢出 | CSS |
| `popoverMenu` | ☰ 桌面专用 | 移动端不出现 → **不改** | — |

---

## 6. 落地批次与验证门禁

每批结束跑 `tsc -b && eslint && vitest`,末批加 `vite build`。

- **批 0 基础设施**:tokens.scss 加 mixin;建 `useIsMobile.ts`;`100vh→100dvh`;viewport 补 `viewport-fit=cover`;把已做的 layout/chat/directory 三处裸 `@media` 回收成 `@include mobile`。
- **批 1 外壳 + 「我」页**:`MeView` + 路由 `/me`;`useLogout()`;`layout` 底部 Tab(标签 i18n `layout.tab.*`)、头像/☰ 桌面化、「我」Tab 移动化。
- **批 2 agentView**:侧栏 → 顶部 Tab 条。
- **批 3 弹窗**:settingView / callModal / cropperModal / fileUploader / addFriendModal / friendModal / profileCard / toast。
- **批 4 门禁 + 自检**:全门禁复跑 + 桌面回归确认。

---

## 7. 风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| 桌面回归 | 误改桌面规则 | 改动仅在 `@include mobile{}` / 移动路由内;桌面元素移动端 `display:none`(如返回按钮、「我」Tab)对桌面不可见 |
| `dvh` 兼容 | 老浏览器不识别 | 保留 `height:100vh` 作前置回退,再 `height:100dvh` 覆盖 |
| `env()` 失效 | 未加 `viewport-fit=cover` 时恒 0 | 与 meta 改动同批落地 |
| antd Modal hack | 若改用 CSS `!important` 覆盖 | 不取,统一走 `useIsMobile()` 传 `width` |
| 断点漂移 | SCSS 与 JS 各持一份 768 | 单一数值 + 注释强约束;改时两处同步 |

---

## 8. 一页结论

- **架构**:Hybrid = CSS 优先 + JS 逃生舱 + 单一断点源(`$bp-md`/`MOBILE_MAX`=768)。新增基础设施仅 **1 个 SCSS mixin + 1 个 `useIsMobile()` hook**。
- **分层**:表现差异走 CSS(`@include mobile`),antd Modal 宽度走 JS hook,结构走路由(`/me`)。
- **信息架构**:移动端头像+菜单合并进 `/me`「我」页,底部 4 Tab;桌面零回归。
- **正确性细节**:`100dvh`、`env(safe-area)`+`viewport-fit=cover`、热区 ≥44px。
- **边界**:验证到 tsc+lint+单测+build;真机交互手感需在浏览器手机视口实测(环境限制)。
