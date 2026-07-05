import ComposableArchitecture
import SwiftUI

struct AgentTasksView: View {
    @Bindable var store: StoreOf<AgentTasksFeature>
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationStack {
            timeline
                .safeAreaInset(edge: .bottom, spacing: 0) { inputBar }
                .background(WeChatColor.background)
                .dismissKeyboardOnTap()
                .navigationTitle("任务")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
        }
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: WeChatSpacing.m) {
                    if store.phase == .idle {
                        idleHint
                    } else {
                        ForEach(Array(store.events.enumerated()), id: \.offset) { index, event in
                            RunEventRow(event: event)
                                .id(index)
                        }
                        if store.phase == .submitting || store.phase == .running {
                            runningIndicator
                        }
                        if store.phase == .finished, let answer = store.finalAnswer {
                            FinalAnswerCard(text: answer)
                        }
                        if store.phase == .failed {
                            failureCard
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(WeChatSpacing.m)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.events.count) { scrollToBottom(proxy) }
            .onChange(of: store.phase) { scrollToBottom(proxy) }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    private var idleHint: some View {
        VStack(spacing: WeChatSpacing.s) {
            Image(systemName: "sparkles")
                .font(.system(size: 32))
                .foregroundStyle(WeChatColor.brand)
            Text("描述一个任务,助手会自动调用工具、逐步完成")
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, WeChatSpacing.xl)
    }

    private var runningIndicator: some View {
        HStack(spacing: WeChatSpacing.s) {
            ProgressView().controlSize(.small)
            Text(store.phase == .submitting ? "提交中…" : "执行中…")
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var failureCard: some View {
        HStack(alignment: .top, spacing: WeChatSpacing.s) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            Text(store.errorMessage ?? "任务失败,请重试")
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(WeChatSpacing.m)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: WeChatRadius.s))
    }

    private var inputBar: some View {
        HStack(spacing: WeChatSpacing.s) {
            TextField("描述一个任务", text: $store.input, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1 ... 4)
                .focused($inputFocused)
                .padding(.horizontal, WeChatSpacing.m)
                .padding(.vertical, WeChatSpacing.s)
                .background(WeChatColor.elevated, in: RoundedRectangle(cornerRadius: WeChatRadius.s, style: .continuous))
                .foregroundStyle(WeChatColor.textPrimary)
                .disabled(isRunning)
                .submitLabel(.send)
                .onSubmit { submit() }

            Button {
                submit()
            } label: {
                Group {
                    if isRunning {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 44, height: 44)
                .background(submitEnabled ? WeChatColor.brand : WeChatColor.textTertiary, in: Circle())
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(!submitEnabled)
            .accessibilityLabel("提交任务")
        }
        .padding(.horizontal, WeChatSpacing.m)
        .padding(.vertical, WeChatSpacing.s)
        .background(WeChatColor.navBar)
    }

    private var isRunning: Bool { store.phase == .submitting || store.phase == .running }

    private var submitEnabled: Bool {
        !isRunning && !store.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        inputFocused = false
        store.send(.submitTapped)
    }
}

// 单条 run 事件:run_started 简讯;tool_called/tool_result 折叠(默认收起)。终态事件由答案/失败卡渲染。
private struct RunEventRow: View {
    let event: RunEvent

    var body: some View {
        switch event.name {
        case "run_started":
            Label("开始执行", systemImage: "play.circle.fill")
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.textSecondary)
        case "tool_called":
            disclosure(
                title: "调用工具 · \(event.toolName ?? "?")",
                systemImage: "wrench.and.screwdriver",
                tint: WeChatColor.brand,
                content: event.toolArgsPretty ?? "无参数",
                monospaced: true
            )
        case "tool_result":
            disclosure(
                title: "工具结果 · \(event.toolName ?? "?")",
                systemImage: "text.append",
                tint: WeChatColor.textSecondary,
                content: event.toolResult ?? "",
                monospaced: false
            )
        default:
            EmptyView()
        }
    }

    private func disclosure(
        title: String,
        systemImage: String,
        tint: Color,
        content: String,
        monospaced: Bool
    ) -> some View {
        DisclosureGroup {
            Text(content)
                .font(monospaced ? .system(.caption, design: .monospaced) : WeChatFont.footnote)
                .foregroundStyle(WeChatColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .padding(.top, WeChatSpacing.xs)
        } label: {
            Label(title, systemImage: systemImage)
                .font(WeChatFont.footnote)
                .foregroundStyle(tint)
        }
        .tint(tint)
        .padding(WeChatSpacing.s)
        .background(WeChatColor.elevated, in: RoundedRectangle(cornerRadius: WeChatRadius.s))
    }
}

// 最终答案:品牌色高亮卡片,收敛终态。
private struct FinalAnswerCard: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: WeChatSpacing.xs) {
            Label("最终答案", systemImage: "checkmark.seal.fill")
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.brand)
            Text(text)
                .font(WeChatFont.body)
                .foregroundStyle(WeChatColor.textPrimary)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(WeChatSpacing.m)
        .background(WeChatColor.brand.opacity(0.08), in: RoundedRectangle(cornerRadius: WeChatRadius.m))
    }
}

#Preview("空态") {
    AgentTasksView(
        store: Store(initialState: AgentTasksFeature.State()) {
            AgentTasksFeature()
        } withDependencies: {
            $0.agentAPI = .previewValue
        }
    )
}

#Preview("执行中") {
    AgentTasksView(
        store: Store(
            initialState: AgentTasksFeature.State(
                phase: .running,
                runId: "run_1",
                events: [
                    RunEvent(name: "run_started", data: #"{"payload":{}}"#),
                    RunEvent(name: "tool_called", data: #"{"payload":{"name":"search_kb","args":{"query":"报销上限"}}}"#),
                    RunEvent(name: "tool_result", data: #"{"payload":{"name":"search_kb","result":"命中 3 段:差旅报销单次不超过 5000 元…"}}"#),
                ]
            )
        ) {
            AgentTasksFeature()
        } withDependencies: {
            $0.agentAPI = .previewValue
        }
    )
}

#Preview("完成(深色)") {
    AgentTasksView(
        store: Store(
            initialState: AgentTasksFeature.State(
                phase: .finished,
                runId: "run_1",
                events: [
                    RunEvent(name: "tool_called", data: #"{"payload":{"name":"search_kb","args":{"query":"违约金"}}}"#),
                    RunEvent(name: "tool_result", data: #"{"payload":{"name":"search_kb","result":"违约金一般不超过实际损失的 30%。"}}"#),
                ],
                finalAnswer: "根据知识库,合同违约金一般不超过实际损失的 30%,超过部分可请求法院酌减。"
            )
        ) {
            AgentTasksFeature()
        } withDependencies: {
            $0.agentAPI = .previewValue
        }
    )
    .preferredColorScheme(.dark)
}
