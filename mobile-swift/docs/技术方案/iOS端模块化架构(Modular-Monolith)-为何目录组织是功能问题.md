# iOS 端模块化架构(Modular Monolith)——为何"目录组织"是功能问题而非视觉问题

> 读者:做架构决策的资深工程师。
> 目的:讲清 SPM 模块化(feature 模块 + Client 接口/Live + 共享模块)是什么架构模式、底层机制是什么,并**用可验证的机制论证**:不同的代码组织不只是"看起来整齐",而是**改变了编译器能强制什么、程序能构建/复用/测试出什么**——即真实的功能与能力差异。
> 结论先行:对本项目当前体量,**保持单 target 分层目录是合理的**;模块化是"体量继续长、要做 Extension/Widget、或编译反馈变慢"时的下一步。本文解释"为什么值",而不是"现在必须做"。

---

## 0. TL;DR

- **"文件夹"对编译器是零语义的**——它只是文件路径。改文件夹名/挪目录,编译产物、可见性、依赖关系**一个 bit 都不变**(本项目 `Sources/**` 通配就是证明:我们刚把 18 个功能目录重排,`BUILD` 与 183 个测试完全不变)。
- **"模块(SPM target)"对编译器是强语义的**——它同时是四样东西的边界:`import` 边界、访问控制边界、增量编译单元、链接单元。跨过它,编译器会**拒绝编译**。
- 因此组织模式的真正差异,是**"边界由人的纪律维持" vs "边界由编译器强制"**。后者带来五类**不是视觉、而是功能/能力**的差异(第 5 章):真封装、可换实现的依赖倒置、Extension/Widget 复用、无环依赖保证、增量编译隔离。
- 代价也真实(第 6 章):`public` 样板、模块图维护、过度拆分反伤小项目。所以给决策框架(第 7 章)与本项目的落地模块图(第 8 章)。

---

## 1. 术语表

| 术语 | 全称 / 展开 | 通俗解释 |
|---|---|---|
| SPM | Swift Package Manager | Swift 官方的包/依赖与构建工具。它**不是架构**,是工具;用它把代码切成多个 target 才产生架构含义。 |
| Module / Target | 编译模块 | 一次编译产出一个 `.swiftmodule` + 二进制的最小单元。`import X` 里的 X 就是 module。**这是本文的主角**。 |
| Modular Monolith | 模块化单体 | 仍是**单进程、单可执行文件**的 app,但内部切成多个有显式依赖的模块。介于"一坨单体"和"微服务"之间。 |
| Vertical Slice | 纵向切片架构 | 按**业务功能**(Chats/Contacts/Me)切,而不是按技术层(所有 View 一层、所有 Model 一层)。 |
| DIP | Dependency Inversion Principle,依赖倒置(SOLID 的 D) | 高层依赖**抽象接口**,不依赖具体实现;实现在运行时/测试时注入。 |
| Ports & Adapters / Hexagonal | 端口与适配器 / 六边形架构 | DIP 的架构形态:核心逻辑定义"端口"(接口),外部实现作为"适配器"接入。`Client`(端口)+ `ClientLive`(适配器)就是它。 |
| DAG / ADP | 有向无环图 / Acyclic Dependencies Principle | 模块依赖必须无环。SPM **强制**这一点(有环直接编译失败)。 |
| Access Control | 访问控制 | Swift 的 `open`/`public`/`package`/`internal`/`fileprivate`/`private`。默认 `internal`。**其语义随"是否分模块"而改变**——这是第 5 章的关键。 |
| Tuist | — | 本项目用它从 `Project.swift` 生成 Xcode 工程/模块;`tuist graph` 能出依赖图。 |

---

## 2. 背景:本项目当前的组织

`mobile-swift` 现状:**单一 target `OurChat`**,`Project.swift` 用 `sources: ["Sources/**"]` 通配收编所有 `.swift`;内部按"分层 + 领域"组织目录:

```
Sources/
  App/            应用组合根(Root 登录门 / Main Tab 容器)
  Features/       Auth · Chats · Contacts · Me · Discover · Search · Call · MiniApp(Agent)
  Services/       各领域 Client(ChatClient/ContactsClient/…)+ Socket/WebRTC/Upload/Session/Agent
  Core/           Networking · Keychain · Auth(JWT) · Util
  Models/ Contracts/ DesignSystem/
```

这套"分层文件夹"方向正确(与 isowords / IceCubesApp 的模块划分同构),但**它们是文件夹,不是模块**。下文论证:这一字之差,决定了很多能力的有无。

---

## 3. 核心事实:module 是什么,folder 是什么

一句话:**在 Swift/Xcode 里,`module` 是编译器的一等公民;`folder` 不是。**

一个 module(= 一个 SPM target / 一个 framework target)同时是**四条边界**:

1. **`import` 边界**:别的代码要用它,必须 `import ModuleName`。
2. **访问控制边界**:只有 `public`(或同包 `package`)的符号能被别的 module 看到;`internal` 只在本 module 内可见。
3. **增量编译单元**:它是"改动 → 重编"的最小/隔离粒度。
4. **链接单元**:它是能被 app / widget / extension / 测试 target **各自挑选链接**的单位。

而一个 **folder**,对以上四条**全部为零影响**:

- 同一个 module 内,文件放哪个文件夹,彼此**无需 `import`、天然互相可见**(默认 `internal` = 整个 module 可见)。
- 挪动文件夹**不改变**任何可见性、依赖、编译产物。

> **可验证证据(本项目)**:`Project.swift` 是 `Sources/**` 通配。我们把 `Features/` 从 18 个平铺目录重排成 8 个分组 + 独立 `App/`,`tuist generate` 后 `xcodebuild test` 结果:**183 tests / 40 suites 全绿,零代码改动**。这恰恰证明:**在单 module 里,目录组织对程序行为的影响 = 0,它确实只有视觉/可读性价值。**

关键推论:**只有当你把目录变成 module,组织才从"视觉"升级成"编译器可强制的语义",也才可能产生功能差异。** 下一章逐条说这些差异。

---

## 4. 一个贯穿全文的真实耦合例子

本项目 `MeClient.profile()` 内部这样实现好友数:

```swift
async let profileTask = client.sendUnwrapping(APIRequest.get("/user/profile"), as: APIUser.self)
async let friendsTask = contacts.contacts()   // ← Me 的 Client 依赖 Contacts 的 Client
```

即 **"我"页的数据源依赖了"通讯录"的数据源**。这是一条真实的跨领域依赖。

- **单 module 下**:这条依赖**在编译器眼里不存在**——`MeClient` 直接引用 `ContactsClient`,不需要声明、没人拦、依赖图上看不见。明天有人让 `ContactsClient` 反过来依赖 `MeClient`,也照样编过,于是产生**隐性环**。
- **模块化下**:`Me` 模块要用 `ContactsClient`,必须在 `Project.swift`/`Package.swift` 里**显式声明依赖** `MeFeature → ContactsClient`;若再声明 `ContactsClient → MeFeature` 就**编译失败(循环依赖)**。依赖关系从"隐性、靠人记"变成"显式、机器管"。

记住这个例子,第 5 章反复用它。

---

## 5. 为什么是功能差异,不是视觉差异(核心章节)

下面五条,每条都给"单 module 会怎样 vs 模块化会怎样"的**机制级对照**,并尽量落到本项目。

### 5.1 封装是"真的"还是"假的"——`internal` 的语义会变

Swift 默认访问级别是 `internal` = **"本 module 内可见"**。这句话的后果完全取决于 module 的大小:

- **单 module app**:整个 app 就是一个 module,于是 **`internal` ≈ "全 app 可见"**。你在 `ChatDetail` 里定义的 `struct MessageBubble`、`func timeText(...)`,**默认对 `MeFeature`、对任何文件都可见**。你**无法用语言表达**"这个类型只属于 Chat 功能内部"——只有 `private`/`fileprivate` 能挡,但那是文件级,跨不了文件。结果:**封装靠自觉,架构靠 code review**。
- **模块化**:`ChatFeature` 模块里不标 `public` 的东西,**别的模块根本看不见**(编译器报 "cannot find type in scope")。你**显式挑选**要暴露的 API(通常就 `ChatFeature.State`/`.Action`/`ChatView`),其余实现细节被**编译器**关在门内。

**这是功能差异吗?是。** 它决定了"跨功能乱伸手"这件事**能不能在编译期被拦住**。单 module 里,`MeView` 直接 `new ChatDetailView(...)` 复用其私有子视图、或读 `ChatDetailFeature` 的内部字段,**全部合法编过**——耦合悄悄长出来,半年后想拆 Chat 发现被 Me 缠住。模块化把这类"非法依赖"变成**编译错误,当场发生,无法合入**。

> Swift 5.9 起还有 `package` 级别:**同一个 SPM package 内跨 module 可见,包外不可见**。它让你在"module 私有(`internal`)"和"对全世界公开(`public`)"之间多一档,做"同一功能簇内部共享、对外仍封闭"。这也是单 module 表达不出来的语义。

### 5.2 依赖倒置能"落地成编译边界"——决定你能不能换实现 / 测试能不能隔离

本项目已用 `@DependencyClient` 做了**值级**的依赖倒置:`ChatClient` 是一组闭包(接口),`liveValue`/`previewValue`/`testValue` 是不同实现。这已经很好。但在**单 module** 里,它有个物理事实绕不过去:

> **接口和 live 实现被编进同一个二进制。** 任何依赖 `ChatClient` 接口的代码,链接时**必然把 `liveValue` 引用的整套实现**(URLSession 网络栈、Socket、GRDB、WebRTC…)一起链进来,哪怕你运行时只用 mock。

模块化把接口与实现**拆成两个 module**(isowords 的 `ApiClient` + `ApiClientLive`):

```
ChatFeature ──depends──▶ ChatClient(接口:一组协议/闭包类型 + testValue/previewValue)
                                   ▲
App(组合根) ──注入──────────────────┘  在启动时把 ChatClientLive 装进去
ChatClientLive ──▶ Networking / Socket / GRDB …(只有它依赖重实现)
```

带来的**能力差异**(不是视觉):

1. **测试真隔离**:`ChatFeature` 的测试 target 只链接 `ChatFeature + ChatClient + mock`,**根本不链接** `ChatClientLive` 那套网络/DB。于是测试**物理上不可能误连生产网络**、编译更快、无需起后端。单 module 下 `@testable import OurChat` 把**整个 app**(含所有 live client、WebRTC 二进制)拖进测试进程。
2. **可换实现 = 新功能**:
   - **Demo/试玩构建**:注入一套返回假数据的 client,`ChatFeature` 代码**一字不改**,产出一个离线可跑的演示版。
   - **App Clip**(轻应用,有 **10MB** 体积上限):只组合 `ChatFeature + 一个精简 client`,把 WebRTC/GRDB 这些重家伙**排除在链接之外**——单 module 做不到,因为它们被焊死在同一个二进制里。
3. **编译爆炸半径可控**(直接呼应我们刚踩的坑):TCA 宏 + swift-syntax 编译很重。接口 module 稳定时,改 `ChatClientLive` 的实现**不会**触发 `ChatFeature` 重新做宏展开;单 module 里任何改动都可能连累整包重编。

### 5.3 复用到 Extension / Widget / Watch——最硬的"能不能做出这个功能"

iOS 的 App Extension(分享扩展、通知服务扩展、CallKit 相关、Widget、Watch app)是**独立的 target、独立的进程、独立且苛刻的体积/启动预算**,并且**扩展 target 不能链接主 app target**。

于是:

- **单 module**:你的登录、Networking、`DesignSystem`、Models 全在 `OurChat` 这个 app target 里。要做一个"分享到 OurChat"扩展或一个"最近聊天" Widget,**没法复用**这些代码——扩展链不进 app target。你只能复制粘贴,或临时抽库。**功能被组织方式挡住了。**
- **模块化**:`DesignSystem`、`Models`、`ChatClient`、某个轻量 `SharedUI` 都是独立 module。Widget target 只 `import DesignSystem, Models, ChatClient` + 一个精简实现,**小、快、可上架**。

这一条是"组织决定产品能力"最直白的证据:**同样的业务代码,组织成 module 才能被第二个可执行体复用;组织成文件夹则不能。** 这不是好不好看的问题,是"这个 Widget 到底做不做得出来"的问题。

### 5.4 无环依赖是"被保证"的——消灭一类真实 bug

模块依赖图必须是 DAG。SPM/Tuist 在你声明出环时**直接编译失败**。这不是洁癖,循环依赖会引发真实故障:

- **初始化顺序/静态依赖死锁**、**retain cycle**(A 模块持 B、B 持 A 的单例)、**牵一发动全身导致无法单独测试/复用**。
- 单 module 里,`MeClient ↔ ContactsClient`(见第 4 章)这种环**随手就能造出来且看不见**;等它长成一团,重构成本极高。
- 模块化下,你**被迫**在设计时就回答"谁依赖谁",把共享部分下沉到公共 module(如把 `Contact`、`ContactsClient` 放进能被 Me 和 Contacts 同时依赖的下层),依赖图**始终可画、始终无环**(`tuist graph` 一键出图)。

**功能差异**:它把"一类架构 bug"从"运行时/维护期踩雷"提前到"设计期编译不过",等于用编译器换掉了一部分靠人力的架构审查。

### 5.5 增量编译隔离——反馈环速度,间接就是产品速度

- **单 module**:Swift 常以 module 为单位做类型推断/宏展开;一处改动很容易触发**整个 module(= 整个 app)重编**。我们这次的 macro 编译之痛、真机整包重编几分钟,正是"单 module 爆炸半径 = 全部"的体现。
- **模块化**:改叶子功能 `SearchFeature`,只重编 `SearchFeature` 及其**下游**;上游的 `DesignSystem`、`ChatFeature` 若公共接口没变,**不重编**。日常反馈从"分钟级"回到"秒级"。

反馈环速度不是玄学:它直接决定单位时间迭代次数,进而决定"这个功能能打磨到什么程度"。这算不算功能差异见仁见智,但它是**实打实的工程能力差异**,不是视觉。

### 小结:五条差异一张表

| 维度 | 单 module + 文件夹 | 模块化(SPM target) | 差异性质 |
|---|---|---|---|
| 封装 | `internal`≈全 app 可见,靠自觉 | 编译器强制,非 `public` 别的模块看不到 | 能否**在编译期拦住乱依赖** |
| 依赖倒置 | 值级 DI,但实现被链进同一二进制 | 接口/Live 分模块,可不链接实现 | 能否**换实现/隔离测试/裁体积** |
| 复用到 Extension/Widget | 不能(扩展链不进 app target) | 能(只链所需模块) | **功能做不做得出来** |
| 循环依赖 | 随手可造且不可见 | 编译失败,强制 DAG | 能否**在设计期消灭一类 bug** |
| 增量编译 | 爆炸半径 = 全 app | 半径 = 改动模块 + 下游 | **反馈环速度 / 迭代能力** |

---

## 6. 代价与反面(诚实评估)

模块化不是免费的,否则所有项目都该拆。真实成本:

- **`public` 样板**:跨模块用的每个类型/初始化器/属性都要显式 `public`(TCA 的 State/Action/View 尤其啰嗦)。`package` 级别能缓解一部分。
- **模块图维护**:多了 N 个 target 的依赖声明、`Project.swift` 变长、组合根(App)要手动把所有 `Live` 注进去。
- **过度拆分反伤**:小项目拆成几十个 module,收益(编译隔离/复用)微乎其微,却付全部样板税——**这正是 TCA 官方 SyncUps 示例保持单 target 扁平的原因**。
- **冷启动/首次全量编译**可能更慢(更多 target 的调度开销);收益在**增量**编译。
- **测试内部实现变绕**:`internal` 被真封住后,测内部细节要用 `@testable import` 或 `@_spi`。

一句话:**模块化是拿"前期样板 + 图维护成本",换"编译期边界 + 复用 + 增量速度"。** 值不值取决于体量与需求(见下)。

---

## 7. 决策框架:什么时候该模块化

按下面信号打分,命中越多越该拆:

| 信号 | 说明 | 本项目现状 |
|---|---|---|
| 要做 Extension/Widget/Watch/App Clip | 复用是硬需求,单 module 直接挡路(5.3) | 暂无,但 IM 常见"分享扩展/来电 Widget/CallKit",**中期很可能有** |
| 增量编译已痛 | 改一行等分钟级 | TCA 宏 + WebRTC,**已有痛感** |
| 多人并行、边界常被踩穿 | code review 频繁挡"乱依赖" | 目前人少,暂不突出 |
| 功能数量大且仍在长 | 纵切模块收益随功能数上升 | 已有 Chats/Contacts/Me/Discover/Search/Call/Agent **7+ 域,仍在长** |
| 需要 Demo/离线/多实现构建 | 依赖倒置到模块级(5.2) | 暂无强需求 |

**判断**:本项目处于"**再长一点就该拆**"的临界区。**不建议现在大爆改**(尤其刚合完 Call/Agent、还有未提交改动);建议**渐进式**(第 8 章),先把最有复用/隔离价值的边界(`DesignSystem`、`Models`、`Networking`、`各 Client 接口`)模块化,Feature 模块随后。

对照业界:小如 **SyncUps** 单 target 扁平;大如 **isowords / IceCubesApp** 全模块化(独立 `Models`/`NetworkClient`/`DesignSystem` + feature 模块)。我们在两者之间、偏向后者的方向演进。

---

## 8. 落到 mobile-swift 的目标模块图与迁移路径

### 8.1 目标依赖图(单向 DAG)

```
                         ┌─────────────┐
                         │     App     │  组合根:@main、Root/Main、把所有 Live 注入
                         └──────┬──────┘
        ┌───────────────┬───────┼───────────────┬───────────────┐
        ▼               ▼       ▼               ▼               ▼
  ┌──────────┐   ┌──────────┐  ...        ┌──────────┐   ┌──────────┐
  │ChatsFeat.│   │Contacts  │             │ CallFeat.│   │AgentFeat.│   ← Feature 模块(纵切)
  └────┬─────┘   └────┬─────┘             └────┬─────┘   └────┬─────┘
       │  依赖"接口",不依赖实现               │               │
       ▼                                        ▼               ▼
  ┌───────────────── Client 接口层 ─────────────────┐   （WebRTCClient / AgentClient …）
  │ ChatClient · ContactsClient · MeClient · …      │   ← 每个是"端口":类型 + testValue/previewValue
  └───────────────┬─────────────────────────────────┘
                  ▼
  ┌──────── 共享基座(被广泛依赖,绝不反向依赖上层)────────┐
  │  Models · DesignSystem · Networking · Contracts        │
  └────────────────────────────────────────────────────────┘

  ┌──────── 适配器层(Live 实现,仅 App 依赖它来注入)────────┐
  │ ChatClientLive · ContactsClientLive · SocketLive · WebRTCLive · AgentLive │
  └──────────────────────────────────────────────────────────┘
```

要点:
- **Feature 模块只依赖 Client 接口 + 共享基座**,不依赖任何 `Live`。
- **`Live` 只被 `App` 依赖**,在启动组合根处注入(`withDependencies`)。
- **`Models`/`DesignSystem`/`Networking` 是最底层**,谁都能依赖它,它不依赖任何 Feature(保证无环)。
- 第 4 章的 `Me→Contacts` 依赖,在这里体现为 `MeFeature → ContactsClient`(接口),显式、可见、无环。

### 8.2 与 Tuist 的契合

本项目已用 Tuist,这反而让模块化**成本更低**:module 就是 `Project.swift` 里多定义几个 `.target(...)` + 声明 `dependencies`。目录几乎不用大动——现有 `Sources/Features/Chats`、`Sources/Services/Chat` 直接升格为 `ChatFeature`、`ChatClient(+Live)` 两个 target 的源目录即可。`tuist graph` 可随时出依赖图做审查。

### 8.3 渐进迁移(低风险,分阶段)

1. **阶段一(最高性价比)**:抽 `DesignSystem`、`Models`、`Networking`、`Contracts` 为独立 module。它们无上游依赖、改动最小、立刻能被未来的 Widget/Extension 复用。
2. **阶段二**:把各 `XxxClient` 拆成 `XxxClient`(接口)+ `XxxClientLive`(实现)两个 module,`App` 负责注入。此步解锁"测试隔离/换实现/裁体积"。
3. **阶段三**:逐个把 Feature 升格为 module(叶子功能如 `Search`、`Discover` 先行验证)。
4. 每步 `tuist generate && xcodebuild test` 保证绿;**因为是纯边界化、非逻辑改动,可随时停在任一阶段**。

---

## 9. 附:Swift 访问控制与 module 机制速查

| 级别 | 可见范围 | 模块化中的用途 |
|---|---|---|
| `open` | 跨 module,且可被继承/重写 | 供外部子类化的类(少见) |
| `public` | 跨 module 可见(不可继承) | 模块对外 API(State/Action/View) |
| `package` | 同一 SPM package 内跨 module | 功能簇内部共享、包外封闭(Swift 5.9+) |
| `internal`(默认) | **本 module 内** | 模块实现细节——模块化后才"真封住" |
| `fileprivate` / `private` | 本文件 / 本作用域 | 更细粒度封装 |

module 的四重身份复述:**`import` 边界 = 访问控制边界 = 增量编译单元 = 链接单元**。folder 一个都不占。这句话是全文的地基。

---

## 10. 参考

- Point-Free, **isowords**(开源 TCA 旗舰 app,`Sources/` 下 60+ module,`ApiClient`/`ApiClientLive` 接口-实现分离):https://github.com/pointfreeco/isowords
- Dimillian, **IceCubesApp**(最流行开源 SwiftUI app,`Packages/` 下独立 `Models`/`NetworkClient`/`DesignSystem` + feature 包):https://github.com/Dimillian/IceCubesApp
- **TCA SyncUps 示例**(小项目单 target 扁平的反例):https://github.com/pointfreeco/swift-composable-architecture/tree/main/Examples/SyncUps
- Robert C. Martin,《Clean Architecture》——依赖倒置(DIP)、无环依赖(ADP)
- Alistair Cockburn——Hexagonal Architecture(Ports & Adapters)
