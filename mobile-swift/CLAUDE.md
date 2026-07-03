# mobile-swift — iOS 原生端(先读仓库根 CLAUDE.md)

栈:Xcode 26 · Swift 6 严格并发 · iOS 18 · **Tuist + SPM** · **TCA** · **SwiftUI**(纯,无 UIKit 兜底)· Swift Testing。
命令/流程见 [README.md](README.md) 与 [docs/](docs/)。

---

# UI/UX 硬规范(强制执行,不可跳过)

> iOS 端做任何 View/交互:先满足原生基本体验,再谈功能。违反 = 体验 bug,不合入。
> 通用 HIG/SwiftUI 用仓内 vendored 的业界主流 skill;下面是本项目特有的硬约定,**直接在此强制,不落普通 docs**。

## 0. 先加载 skill(必须)

改任何 iOS UI 前,先加载 `.claude/skills/` 里两个 skill(MIT,已入库):
- **`mobile-ios-design`**(`wshobson/agents`):HIG/UX —— 导航、自适应布局、安全区、语义色明暗、Dynamic Type、SF Symbols、反硬编码色。
- **`swiftui-pro`**(Paul Hudson):SwiftUI 现代 API / 性能 / 可维护性 / 无障碍 review(自带 44pt、Dynamic Type、VoiceOver 强约束)。

优先用 Skill 工具按名调用;若未被自动发现,直接 `Read` 其 `SKILL.md` + `references/`。**通用 HIG/SwiftUI 以这两个 skill 为准,别凭记忆手写通用规则。**

## 1. 键盘与文本输入【必须】

- 点输入框外空白处**收起键盘**(`@FocusState` + §7 `dismissKeyboardOnTap()`)。
- 键盘弹出**不遮挡**当前输入框:输入区放 `ScrollView`,底部输入条用 `.safeAreaInset(edge: .bottom)`。
- `.scrollDismissesKeyboard(.interactively)`;`@FocusState` 管焦点 + `.submitLabel(.next/.go)` + `.onSubmit{}` 切下一项/提交。
- `.textContentType(.username/.password/.oneTimeCode)` 支持自动填充;`.keyboardType`、`.textInputAutocapitalization(.never)` 按场景给。

```swift
ScrollView {
    TextField("账号", text: $store.account.sending(\.accountChanged))
        .textContentType(.username).focused($focus, equals: .account).submitLabel(.next)
    SecureField("密码", text: $store.password.sending(\.passwordChanged))
        .textContentType(.password).focused($focus, equals: .password).submitLabel(.go)
}
.scrollDismissesKeyboard(.interactively)
.dismissKeyboardOnTap()
.onSubmit { focus == .account ? (focus = .password) : store.send(.loginTapped) }
```

## 2. 触摸目标与点击反馈【必须】

- 可点元素命中区 **≥ 44×44 pt**(小图标按钮 `.frame(minWidth:44,minHeight:44)` + `.contentShape(Rectangle())`)。
- 所有可点元素有**按下反馈**(用 §7 `PressableButtonStyle`),**禁止死按钮**。
- 关键/破坏性操作加触觉:`.sensoryFeedback(.impact, trigger:)`。

## 3. loading / empty / error 三态 + 网络反馈【必须】

- 任何异步数据(会话/好友/消息/登录)覆盖 **loading / empty / error** 三态;**empty 不能长得像 error**(呼应仓库根 CLAUDE.md)。
- 网络失败给**人话 + 可重试**,不白屏、不死转圈、不把 `NSURLErrorDomain -1004` 抛给用户。
- 轻提示用非阻断 toast;需用户决策才 `.alert`;按钮进 loading 时禁用防重复提交。
- TCA:State 用 `enum ViewState { loading/loaded([X])/empty/failed(String) }`,View `switch` 穷举(§7 `AsyncStateView`)。

## 4. 主题令牌【必须】

- 颜色/字体一律走 `WeChatTheme` / `WeChatFont` 语义令牌,**禁止 `Color(hex:)`/字号硬编码散落 View**;明、暗两套都实测。
- `WeChatFont` 语义字号基于 text style / `@ScaledMetric`,支持 Dynamic Type,最大档不溢出。

## 5. TCA · View 约定【必须】

- View 用 `@Bindable var store: StoreOf<XxxFeature>`(不是 `let`),State 标 `@ObservableState`,直接读 `store.xxx`;**别用旧 `WithViewStore`**。
- Preview 用 `previewValue` 依赖,离线可渲染;Reducer 高覆盖单测(docs/03 §8)。

## 6. 提交前 UX 自检清单【必须,过不了不提交】

- [ ] 已加载 `mobile-ios-design` + `swiftui-pro` skill
- [ ] 有输入框的页:点空白收键盘 ✔ 键盘不遮挡 ✔ Return 语义 ✔
- [ ] 可点元素:命中区 ≥44pt ✔ 有按下反馈 ✔(无死按钮)
- [ ] 异步页面:loading/empty/error 三态齐全,empty≠error;网络失败可重试
- [ ] 颜色/字体走 `WeChatTheme`/`WeChatFont` 令牌;明 & 暗都过一遍
- [ ] 安全区 + iPhone SE 小屏 + 大屏都不破版;Dynamic Type 最大档不溢出

## 7. 配套可复用组件(落到 `Sources/DesignSystem/UX/`)

```swift
import SwiftUI

// ① 点空白收键盘 —— 挂页面容器,不吞按钮点击(SwiftUI 按钮手势优先级更高)
extension View {
    func dismissKeyboardOnTap() -> some View {
        onTapGesture {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
    }
}

// ② 统一按下反馈 —— 所有自定义按钮用它,杜绝"死"按钮
struct PressableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// ③ 三态容器 —— 强制 loading/empty/error 分支
struct AsyncStateView<Item, Content: View>: View {
    enum State { case loading; case empty(String); case failed(String, retry: () -> Void); case loaded([Item]) }
    let state: State
    @ViewBuilder let content: ([Item]) -> Content
    var body: some View {
        switch state {
        case .loading: ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .empty(msg): ContentUnavailableView(msg, systemImage: "tray")
        case let .failed(msg, retry):
            ContentUnavailableView { Label("加载失败", systemImage: "wifi.exclamationmark") }
                description: { Text(msg) }
                actions: { Button("重试", action: retry).buttonStyle(PressableButtonStyle()) }
        case let .loaded(items): content(items)
        }
    }
}
```

---

# 其它约定

- **Git**:提交在仓库根执行 `git add mobile-swift/`,别在此 `git init`;`.xcodeproj/.xcworkspace/Derived` 是 Tuist 产物不入库,`.claude/skills/` 随仓库走。
- **skill 维护/来源**:`mobile-ios-design` = `github.com/wshobson/agents`(`plugins/ui-design/skills/mobile-ios-design`,MIT);`swiftui-pro` = `github.com/twostraws/SwiftUI-Agent-Skill`(Paul Hudson,MIT)。升级:重拉对应 `SKILL.md`+`references/` 覆盖,**人工 review diff 再合入**,不盲目跟版本。
- **已知问题(服务器连通)**:`Sources/Core/Networking/APIEnvironment.swift` 全局用 `dev = http://localhost:3007`(`SocketClient.swift` 亦然),本地 `server/` 没起就报 `-1004`。二选一:本地 `cd server && npm run dev`;或加 `APIEnvironment.prod = https://tujiang.tech`(socket 用 `wss`,注意 ATS)按 build 切换。
- 控制台里 `Hang detected(debugger attached)`、`SystemInputAssistantView.height==45` 约束冲突、`Received external candidate resultset`(键盘联想词)均为系统噪音,可忽略;真错只有上面的 `-1004`。
