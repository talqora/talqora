# iOS 端模块化重构 —— 进度复盘与后续计划

> 日期:2026-07-06 · 分支:`ios`(未提交)
> 用途:记录本轮 iOS 侧改造的全景、已验证的模块化配方、以及后续拆分计划与已探明的坑。**更新至 Core 抽取完成(共 4 个模块、`Core↔Services` 循环已破)。**

---

## 0. 一句话现状

当前处于**干净、可编译、183 测试全绿**的检查点:
- 功能:6 项 UX/导航需求已补齐(见 §1),并合入了 `main` 的通话(WebRTC/Call)与 Agent/MiniApp。
- 结构:`Sources/Features/` 从 18 个平铺目录重排为 8 个内聚域 + 独立 `App/` 外壳。
- 模块化:**Phase 1 + Phase 2 + Phase 3 全部完成**——共 **13 个 Tuist framework target**:
  - 基础/领域层:`Models`、`Contracts`、`DesignSystem`、`Core`、`Services`(Phase 1+2);`Core↔Services` 循环经依赖倒置打破,`Services→Features` 反向依赖(`MeProfile`/`CallType`)已下沉 `Models`。
  - 功能层(Phase 3):`Auth`、`Search`、`Discover`、`Me`、`Call`、`MiniApp`、`Chats`、`ContactBook`(通讯录,**不能叫 Contacts**,见 §6)。
  - 功能间依赖 DAG:`Chats → Search / MiniApp`,`ContactBook → Chats`(复用 `ChatDetailFeature`),其余为叶子;功能→功能只经 delegate,无反向边。
  - `OurChat` app target 现只剩 `Sources/App/**`——纯组合根(装配所有 Feature + 注入所有 Live)。边界全部由编译器强制。
- 文档:两篇架构文档(`docs/技术方案/` iOS 篇 + web 篇)+ 本复盘。

**未提交**——一切改动都在 `ios` 工作区。

---

## 1. 本轮功能改动(已完成,已验证)

| # | 需求 | 落地 |
|---|---|---|
| 1 | 会话列表整行可点 | `ConversationRow` 加 `.contentShape(Rectangle())` |
| 2 | 好友详情页 + 好友设置页 | 通讯录改 TCA `StackState` 栈;好友资料页(图10)+ 好友设置页(图11);发消息/备注真实,音视频通话由合入的 Call 模块接管 |
| 3 | 二级页不留底部 tab | 所有 pushed 页加 `.toolbar(.hidden, for: .tabBar)` |
| 4 | 个人资料页 | Me 头像/整行 → 个人资料页(图12);头像上传+裁剪、名字(nickname)真实,其余占位 |
| 5 | 重设计设置页 | 图13-15 分组;界面与显示(主题/语言)、个人资料、退出登录真实 |
| 6 | 占位点弹提示 | 全局 `ToastCenter`(注入 AppView),无死按钮 |

顺带修的潜伏 bug:① 旧 MeView 无 `.task`,`onAppear` 从未触发、资料没加载 → 已补;② `AppView` 用 `.overlay` 装 `ToastOverlay` 时子节点拿不到注入的 toast,启动即崩 → 改 `ZStack` 修复。

---

## 2. 目录重排(已完成)

```
Sources/
  App/            OurChatApp · Root(登录门) · Main(Tab 容器)   ← 应用组合根独立
  Features/       Auth · Chats(+ChatDetail) · Contacts(+ContactDetail/FriendSettings/RemarkEdit/NewFriends)
                  Me(+Profile/Settings/Appearance) · Discover · Search · Call · MiniApp
  Services/ Core/ Models/ Contracts/ DesignSystem/
Tests/  App/ · Features/{Auth,Chats,Contacts,Me,Call,Search,MiniApp}/ · Core/ Services/ DesignSystem/
```
纯文件移动:单 target `Sources/**` 通配、同模块无跨文件 import → 对编译零影响(重排后 183 测试不变即为证)。

---

## 3. 已完成:4 个模块

当前模块图(编译器强制边界):
```
OurChat(app) ─▶ Services · Core · Models · Contracts · DesignSystem + 其它 external
Services     ─▶ Core · Models · Contracts + Dependencies/DependenciesMacros/SocketIO/WebRTC
Core/Models/Contracts/DesignSystem —— 叶子,互不依赖
Tests        ─▶ OurChat + 上述五模块(测内部件用 @testable import)
```
`Project.swift` 现有 6 个 target:`Core`/`Models`/`Contracts`/`DesignSystem`/`Services` + `OurChat`(app)+ `OurChatTests`。

> Services 的公共面目前偏宽(blanket-public 后只回退了明确内部的引擎/委托类):各 parser、samples、`SSEParser` 等本可 `internal` + `@testable`。留作与 `.framework→static`、每模块测试 target 一起的**收敛 pass**。

### 3.1 已验证 3 次的「模块化机械配方」
1. **加 `public`**:类型/成员/`init`/`body` 全 public;跨模块构造的 struct **必须显式 `public init`**(memberwise init 默认 internal)。SwiftUI View 用 `public var body`。
2. **`Project.swift` 加 target**:framework、独立 `sources: ["Sources/<Mod>/**"]`、声明 external 依赖;把该目录从 `OurChat` 的 `sources` 列表移除,并给 `OurChat`(和 `OurChatTests`)加 `.target(name:)` 依赖。
3. **注入 `import <Mod>`**:批量脚本(见 §6 坑:**zsh 不做单词分割**,循环用 `while IFS= read -r`)。贪婪注入无害(未用 import 只是 warning),漏的由编译器精确报出再补。

### 3.2 每模块的具体外部依赖
- `Models`:仅 Foundation。
- `Contracts`:OpenAPIRuntime(`Types.swift` 生成码已是 public;手写 `Aliases.swift` 的 typealias 补 public;注意生成码被贪婪脚本误注入的 `import Models` 要清掉)。
- `DesignSystem`:Kingfisher(Avatar 用 KFImage)。

---

## 4. Core 抽取(**已完成,183 测试全绿**)

### 4.1 关键发现:Core 不是干净叶子,有 3 处对 Services 的隐藏纠缠
(都是 `DependencyValues`/错误类型引用,grep 按类型名扫不出来 —— 这正是"文件夹式分层"看不见的隐性耦合,SPM 模块会当场报错)

| # | 纠缠 | 已采用的解法 |
|---|---|---|
| 1 | `APIClient.liveValue` → `@Dependency(\.authService)`(**循环**) | 依赖倒置:Core 定义 `TokenRefresher` 抽象(`@DependencyClient`,含 `refresh`/`onRefreshFailure`,默认 fail-closed),`APIClient.liveValue` 改用 `@Dependency(\.tokenRefresher)`;`authService` 的实装移到 `OurChatApp` 的 `prepareDependencies`(组合根) |
| 2 | `Core/TurnCredentialsClient` → `IceServerDTO`(在 `Services/WebRTC`) | `TurnCredentialsClient` 只被 `CallFeature` 用,已**移到 `Sources/Services/WebRTC/`**(测试同移);它 `import Core` 取 `apiClient` |
| 3 | `Core/loadErrorMessage` → `AuthError`(在 `Services/Auth`) | `AuthError` 已**下沉进 `Sources/Core/AuthError.swift`**(`public`);`AuthService` 删除原定义、改 `import Core` |

### 4.2 已执行步骤(有序,实际生效)
1. 新建 `Sources/Core/AuthError.swift`(`public enum AuthError`);从 `AuthService.swift` 删原定义。
2. `TurnCredentialsClient.swift` 移到 `Sources/Services/WebRTC/`;`Tests/…TurnCredentialsClientTests.swift` 移到 `Tests/Services/WebRTC/`。
3. 新建 `Sources/Core/Networking/TokenRefresher.swift`;`APIClient.liveValue` 改用 `\.tokenRefresher`(不再引 `authService`)。
4. `OurChatApp.store` 用 `prepareDependencies { $0.tokenRefresher = TokenRefresher(refresh:{…authService.refresh()}, onRefreshFailure:{…authService.logout()}) }` 包裹后再建 Store。
5. Core 11 文件全量 `public`(含各 `@DependencyClient` 的 `liveValue` —— 见 §6 坑)。
6. `Project.swift` 加 `Core` target(external:`Dependencies`、`DependenciesMacros`);`OurChat.sources` 移除 `Sources/Core/**`;`OurChat`/`OurChatTests` 加 `.target(name:"Core")`。
7. 注入 `import Core`(47 处);剔除 Contracts 被贪婪脚本误注入的 `import Core`。

### 4.3 实际用的「两段法」(把内容 bug 和翻模块 bug 分开,强烈推荐后续沿用)
- **Phase A(内容重构,保持单模块绿)**:步骤 1–5 都是单模块内合法改动(`public` 在单模块无害、移文件不改 import)。做完先 `xcodebuild test` 一次 —— 只暴露了 **1 个** `KeychainStore.liveValue` 缺 `public`,修掉即过。
- **Phase B(翻模块,原子)**:步骤 6–7(改 `Project.swift` + 注入 import)一起做,再 build 一次绿。
- 好处:Phase A 的绿保证"逻辑对",Phase B 只剩"边界/import"问题,不会被几十个缺 import 淹没真正的内容错误。

---

## 5. Phase 3 已完成:8 个 Feature 逐个升模块

按依赖 DAG 从叶子到根逐个抽,每个 feature 一个 `xcodebuild test` 检查点(基线恒为 183/40):
`Auth`(pilot)→ `Search` → `Discover` → `Me` → `Call` → `MiniApp` → `Chats`(需 Search/MiniApp)→ `ContactBook`(需 Chats)。

**每个 feature 的机械配方(已 8 次验证)**:
1. 只把 **App/其它模块引用到的顶层类型** 升 `public`:`XxxFeature`(struct+`init`+State+Action+`body`)、被 App 呈现的顶层 View。子 View、内部 enum(`Tab`/`ListPhase`/`CallPhase` 等)保持 `internal`。
2. **子 reducer 只在同模块内(父 `Scope`/`@Reducer enum Path`)与 `@testable` 测试里构造** → 类型要 `public`(Reducer 一致性要求 State/Action `public`),但 **init 保持 synthesized internal**,不写显式 `public init`(否则会抹掉 memberwise init,previews/tests 传参即断)。
3. **public reducer 的 `.run` 闭包会因 self 非 Sendable 报错**——两条对策见 §6:优先给 reducer 加 `: Sendable`(它的存储属性只有 `@Dependency`,天然 Sendable),保持 body 原样、语义与已绿版本逐字节一致。
4. `Project.swift` 加 framework target(deps:Core/Models/DesignSystem/Services + 依赖到的其它 feature target + ComposableArchitecture);从 `OurChat.sources` 移除该目录;`OurChat`/`OurChatTests` 加 `.target(name:)`。
5. 注入 `import <Feature>` 到引用方(App 组合根 + 跨 feature 引用方);测试 `@testable import OurChat` → `@testable import <Feature>`。

## 5.1 后续可选收敛(非本轮范围)

- **Client 接口/Live**:每个 `XxxClient` 留接口,`liveValue` 移 App 组合根 / `*Live` 模块 → 测试不链接实装、可换实现、可裁 bundle。
- **Services 公共面收敛** + `.framework → .staticFramework`(需先每模块拆测试 target)。
- 目标依赖图见 `docs/技术方案/iOS端模块化架构(Modular-Monolith)…md` §8。

---

## 6. 已探明的坑(避免重复踩)

- **zsh 不做单词分割**:`for f in $files` 会把整串当一个词;批量处理用 `… | while IFS= read -r f; do …`。
- **贪婪 import 注入的误伤**:`\bConversation\b` 命中 `Components.Schemas.Conversation`、`\bMessagePreview\b` 命中 `Components.Schemas.MessagePreview` —— 会给生成码 `Types.swift`/`Aliases.swift`(Contracts 模块)误加 `import Models`/`import Core`。**叶子模块(Models/Contracts/DesignSystem)彼此及对 Core 都不依赖**,注入后务必回清,否则报 "No such module"。
- **public 类型的 DependencyKey.liveValue 必须 public**:`public struct X` + `@DependencyClient` + `extension X: DependencyKey { static let liveValue }` 时,`liveValue` 要显式 `public`(否则报 "property 'liveValue' must be declared public because it matches a requirement in public protocol 'DependencyKey'")。Core 的 `KeychainStore`/`APIClient`/`TokenRefresher` 都踩过。
- **循环藏在 DependencyValues 引用里**:`@Dependency(\.authService)` 这种跨层引用 grep 按类型名扫不出;抽模块前用「谁在 `liveValue` 里 `@Dependency(\.x)` 了别层的 x」来找循环。破法是依赖倒置(在本层定义抽象、实装移到组合根 `prepareDependencies`)。
- **macro「malformed response」**:Xcode GUI 真机构建 + 实时索引抢宏插件会误报;命令行 `xcodebuild` 一直干净。构建正确性以命令行为准(已记入项目 memory)。
- **单 target `Sources/**` 通配**:抽模块时务必把该目录从 `OurChat.sources` 列表移除,否则文件被双重编译。
- **验证命令**:`cd mobile-swift && tuist generate --no-open && xcodebuild test -workspace OurChat.xcworkspace -scheme OurChat -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`;基线 **183 tests / 40 suites**。

### 6.1 Phase 3(Feature 模块化)新踩的坑

- **public struct 丢失隐式 `Sendable` → `.run` self-capture 编译错误**:public reducer 的 `.run { send in … }` 访问 `self.someDep` 时报 `capture of 'self' with non-Sendable type`。两条解法:
  - **(推荐)给 reducer 加 `: Sendable`**——存储属性只有 `@Dependency`(本身 Sendable),故 struct 天然可 Sendable。body 原样不动,语义与已绿版本逐字节一致,是**最低风险**改法(CallFeature 17 个 `.run`、MiniApp/Chats/Contacts 全用它)。
  - (次选)`.run { [dep1, dep2] send in … }` 显式捕获——但见下一条陷阱。
- **eager 捕获列表会误触 "dependency has no test implementation"**:`.run { [uploadClient, meClient] send in … }` 会在**effect 创建时立即解析** `meClient`;若该闭包里 `meClient` 是在 `uploadClient.xxx()`(可能先抛)之后才用、而某测试只 stub 了 `uploadClient`(抛),则 `meClient` 未被 stub → eager 解析即报 `@Dependency(\.meClient) has no test implementation, but was accessed`。原 self-lazy 版本不会(用到那行才解析)。解法:该 dep 改在**闭包内**用 `@Dependency(\.meClient) var meClient` 解析(还原惰性),或直接用上面的 `: Sendable` 方案。
- **`@Reducer enum Path` / 父 `Scope` 组合会把整条 reducer 链拽成 public**:父 `Action` 有 `case path(StackActionOf<Path>)` 或 `case child(ChildFeature.Action)`,父 Action `public` ⇒ 关联类型 `Child.Action` 必须 `public` ⇒ `ChildFeature` 必须 `public` ⇒ 其 State/Action 都 `public`(Reducer 一致性)。Me / MiniApp / Contacts 的子 feature 全因此升 public。但**子 View 不受影响**,仍 internal(只有被 App/别的模块直接引用的顶层 View 才 public)。
- **模块名撞 Apple 系统框架 = 启动即崩(最隐蔽)**:模块起名 `Contacts` 生成 `Contacts.framework`,与系统 `Contacts.framework` 同名 → 运行时 dyld 误加载/串到系统框架,拉起 `ContactsUICore` 在 Combine `Published` 元数据实例化处 `SIGSEGV`(编译期完全无警告,只在**跑测试/启动**时崩)。改名 `ContactBook` 解决。**教训:feature 模块名要避开系统框架名(Contacts/ContactsUI/Search? 实测 Search 没撞、Contacts 撞)**;拿不准就查 `ls /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/…/Frameworks`。
- **改完 target 图(尤其重命名 framework)务必清 DerivedData**:改名后仍崩、且崩点变成 `objc_fatal` in `load_categories`(load_images 阶段)——是 DerivedData 里残留旧 `Contacts.framework` 与新图串味。`rm -rf ~/Library/Developer/Xcode/DerivedData/OurChat-*` 后重新 `tuist generate` + test 即绿。
- **跨模块构造 State 时 memberwise init 的取舍**:被**别的模块**构造的 State(如 App 建 `CallFeature.State()`、Contacts 建 `ChatDetailFeature.State(conversationId:…)`)必须给 `public init`,且参数类型也要 public(为此 `CallPhase`/`CallRole` 升 public)。只在**本模块内 + `@testable` 测试**构造的子 State**不写**显式 init,留 synthesized internal memberwise init 即可(previews/tests 传参照用)。App 侧原本用「建空 State 再逐字段赋值」的,改为用 public memberwise init 一次构造(封装更好、public 面更小)。

---

## 7. 回退

所有改动未提交,`git checkout -- <file>` 可回退单文件;`Project.swift` 回退到单 `OurChat` target(`sources: ["Sources/**"]`)即回到未模块化状态。模块目录本身不需移动(仍在 `Sources/<Mod>/`)。
