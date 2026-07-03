# OurChat iOS · mobile-swift

> our-chat 项目的 iOS 原生客户端。技术栈贴合 2026 业界最佳实践,与 `mobile-flutter/` 并列、互不依赖。

## 一行环境概览

- **Xcode 26** · **Swift 6** strict concurrency · **iOS 18.0** 最低部署目标
- **Tuist** 管理工程 · **SPM** 管理依赖 · **TCA** 做状态管理与架构
- **SwiftUI** 单 UI 栈(无 UIKit 兜底,有需求再桥接)
- **Swift Testing**(WWDC 2024,非 XCTest)

## 5 分钟跑起来

```bash
# 1. 装工具(只需一次)
brew install tuist swiftlint swiftformat

# 2. 拉依赖 + 生成 Xcode 工程
cd mobile-swift
tuist install      # 拉 SPM 依赖到 Tuist/Dependencies/
tuist generate     # 生成 OurChat.xcworkspace

# 3. 打开
open OurChat.xcworkspace
# 在 Xcode 里 Cmd+R 跑模拟器
```

跑通后看到一个最小占位界面。本仓库**只交付框架**:
- 工程清单(Tuist + SPM 依赖锁定)
- 编译/Lint/Format 配置
- 资源目录骨架(AppIcon / AccentColor 占位)
- 全套文档(选型 / 工程结构 / 流程 / 依赖 / 排错)

所有业务代码(Feature / Model / Service / Tests)请按 [docs/02-工程结构.md](docs/02-工程结构.md) 的约定自行添加到 `Sources/` 和 `Tests/` 目录。

> **UI/UX 是强制硬规范,全部写在 [CLAUDE.md](CLAUDE.md)**(会被自动加载强制执行,不放普通 docs):通用规则用仓内两个业界主流 skill(`.claude/skills/` 的 `mobile-ios-design` + Paul Hudson `swiftui-pro`),项目特有约定(点空白收键盘、≥44pt 命中、按下反馈、loading/empty/error 三态、`WeChatTheme` 令牌、TCA View)+ 提交前自检清单都在 CLAUDE.md。

## 命令行启动(不开 Xcode)

`OurChat.xcworkspace` 是 Tuist 生成产物、不入库,所以任何命令行启动前都要先 `tuist generate`。

**方式 A · Tuist 原生(最简)**

```bash
cd mobile-swift
tuist install            # 首次或依赖变动时才需要
tuist generate --no-open # 生成 workspace,不弹 Xcode
tuist run OurChat        # 编译并在模拟器启动
# 指定机型:tuist run OurChat --device "iPhone 16"
```

**方式 B · xcodebuild + simctl(最稳,`tuist run` 选错模拟器时用)**

```bash
cd mobile-swift
tuist generate --no-open

xcodebuild -workspace OurChat.xcworkspace -scheme OurChat \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -derivedDataPath ./Derived build

xcrun simctl boot "iPhone 16" 2>/dev/null; open -a Simulator
xcrun simctl install booted ./Derived/Build/Products/Debug-iphonesimulator/OurChat.app
xcrun simctl launch booted com.ourchat.ios
```

可用机型:`xcrun simctl list devices available`。

## 热更新样式

按代价从小到大三档:

| 方式 | 粒度 | 是否需重跑 App | 就绪状态 |
|------|------|----------------|----------|
| **Xcode Preview(`#Preview`)** | 单个 View | 否,存盘后 Canvas 即时刷新 | ✅ 内置,`previewValue` 离线渲染(详见 docs/03 §6) |
| **InjectionIII / Inject** | 运行中的真实 App | 否,存盘热注入、保留导航栈与状态 | ❌ 未配置,需接一次 |
| 全量 `tuist run` | 整个 App | 是 | ✅ |

- **改样式令牌(WeChatTheme / WeChatFont)首选 Preview**:零配置、零网络、闭环最快。
- 想在**运行中的 App**里热改深层页面样式,才需要 **Inject**(SwiftUI + TCA 完全支持),接入四步:
  1. `Tuist/Package.swift` 加 `Inject` 依赖,`Project.swift` 加 `.external(name: "Inject")` + **仅 Debug** 的 `OTHER_LDFLAGS: -Xlinker -interposable`;
  2. 装 InjectionIII(或 InjectionNext)Mac 端;
  3. 每个 View 末尾加 `@ObserveInjection var inject` + `.enableInjection()`;
  4. InjectionIII 挂上项目后,存盘即热重载(命令行启动的模拟器 App 同样生效)。
