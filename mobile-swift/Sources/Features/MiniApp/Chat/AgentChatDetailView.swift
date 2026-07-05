import ComposableArchitecture
import SwiftUI

struct AgentChatDetailView: View {
    @Bindable var store: StoreOf<AgentChatFeature>
    @FocusState private var inputFocused: Bool

    var body: some View {
        messageList
            .safeAreaInset(edge: .bottom, spacing: 0) {
                inputBar
            }
            .background(WeChatColor.background)
            .dismissKeyboardOnTap()
            .navigationTitle(store.currentTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: WeChatSpacing.m) {
                    if store.messages.isEmpty {
                        emptyHint
                    }
                    ForEach(Array(store.messages.enumerated()), id: \.offset) { index, message in
                        AgentMessageBubble(
                            message: message,
                            isStreamingPlaceholder: store.isStreaming && index == store.messages.count - 1
                        )
                        .id(index)
                    }
                }
                .padding(.horizontal, WeChatSpacing.m)
                .padding(.vertical, WeChatSpacing.m)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.messages.count) {
                scrollToBottom(proxy)
            }
            .onChange(of: store.messages.last?.content) {
                scrollToBottom(proxy)
            }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        guard !store.messages.isEmpty else { return }
        withAnimation { proxy.scrollTo(store.messages.count - 1, anchor: .bottom) }
    }

    private var emptyHint: some View {
        VStack(spacing: WeChatSpacing.s) {
            Image(systemName: "sparkles")
                .font(.system(size: 32))
                .foregroundStyle(WeChatColor.brand)
            Text("向知识库提问,回答会带来源引用")
                .font(WeChatFont.footnote)
                .foregroundStyle(WeChatColor.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, WeChatSpacing.xl)
    }

    private var inputBar: some View {
        HStack(spacing: WeChatSpacing.s) {
            TextField("输入问题", text: $store.input, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1 ... 4)
                .focused($inputFocused)
                .padding(.horizontal, WeChatSpacing.m)
                .padding(.vertical, WeChatSpacing.s)
                .background(WeChatColor.elevated, in: RoundedRectangle(cornerRadius: WeChatRadius.s, style: .continuous))
                .foregroundStyle(WeChatColor.textPrimary)
                .disabled(store.isStreaming)
                .submitLabel(.send)
                .onSubmit { store.send(.sendTapped) }

            Button {
                inputFocused = false
                store.send(.sendTapped)
            } label: {
                Group {
                    if store.isStreaming {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                }
                .frame(width: 44, height: 44)
                .background(
                    sendEnabled ? WeChatColor.brand : WeChatColor.textTertiary,
                    in: Circle()
                )
            }
            .buttonStyle(PressableButtonStyle())
            .disabled(!sendEnabled)
            .accessibilityLabel("发送")
        }
        .padding(.horizontal, WeChatSpacing.m)
        .padding(.vertical, WeChatSpacing.s)
        .background(WeChatColor.navBar)
    }

    private var sendEnabled: Bool {
        !store.isStreaming && !store.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

// AI 对话气泡:user 右对齐微信绿,assistant 左对齐卡片;assistant 有引用时底部显示来源角标。
private struct AgentMessageBubble: View {
    let message: AgentMessage
    let isStreamingPlaceholder: Bool

    private var isUser: Bool { message.role == "user" }

    var body: some View {
        HStack(alignment: .top) {
            if isUser { Spacer(minLength: 48) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: WeChatSpacing.xs) {
                bubbleText
                if !isUser, let citations = message.citations, !citations.isEmpty {
                    CitationBar(citations: citations)
                }
            }
            if !isUser { Spacer(minLength: 48) }
        }
    }

    @ViewBuilder
    private var bubbleText: some View {
        if !isUser, isStreamingPlaceholder, message.content.isEmpty {
            // 流式刚开始还没 token:显示打字指示,不显示空气泡。
            HStack(spacing: WeChatSpacing.xs) {
                ProgressView().controlSize(.small)
                Text("思考中…")
                    .font(WeChatFont.footnote)
                    .foregroundStyle(WeChatColor.textSecondary)
            }
            .padding(.horizontal, WeChatSpacing.m)
            .padding(.vertical, 9)
            .background(WeChatColor.elevated, in: RoundedRectangle(cornerRadius: WeChatRadius.s, style: .continuous))
        } else {
            Text(message.content)
                .font(WeChatFont.body)
                .foregroundStyle(isUser ? Color(hex: 0x111111) : WeChatColor.textPrimary)
                .padding(.horizontal, WeChatSpacing.m)
                .padding(.vertical, 9)
                .background(
                    isUser ? WeChatColor.brand : WeChatColor.elevated,
                    in: RoundedRectangle(cornerRadius: WeChatRadius.s, style: .continuous)
                )
                .textSelection(.enabled)
        }
    }
}

// 来源角标条:assistant 回答下方展示"来源 N"标签。
private struct CitationBar: View {
    let citations: [Citation]

    var body: some View {
        HStack(spacing: WeChatSpacing.xs) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(WeChatFont.caption2)
                .foregroundStyle(WeChatColor.textSecondary)
            ForEach(Array(citations.enumerated()), id: \.offset) { index, _ in
                Text("来源 \(index + 1)")
                    .font(WeChatFont.caption2)
                    .foregroundStyle(WeChatColor.brand)
                    .padding(.horizontal, WeChatSpacing.s)
                    .padding(.vertical, 3)
                    .background(WeChatColor.brand.opacity(0.12), in: Capsule())
            }
        }
    }
}

#Preview("详情") {
    NavigationStack {
        AgentChatDetailView(
            store: Store(
                initialState: {
                    var s = AgentChatFeature.State()
                    s.currentConversationId = 1
                    s.currentTitle = "关于合同条款的问题"
                    s.messages = [
                        AgentMessage(id: 1, role: "user", content: "合同违约金上限是多少?", citations: nil),
                        AgentMessage(
                            id: 2,
                            role: "assistant",
                            content: "根据知识库,违约金一般不超过实际损失的 30%。",
                            citations: [
                                Citation(chunkId: 11, documentId: 3, score: 0.87),
                                Citation(chunkId: 12, documentId: 3, score: 0.71),
                            ]
                        ),
                    ]
                    return s
                }()
            ) {
                AgentChatFeature()
            } withDependencies: {
                $0.agentAPI = .previewValue
            }
        )
    }
}

#Preview("流式中(深色)") {
    NavigationStack {
        AgentChatDetailView(
            store: Store(
                initialState: {
                    var s = AgentChatFeature.State()
                    s.currentConversationId = 1
                    s.currentTitle = "报销流程"
                    s.isStreaming = true
                    s.messages = [
                        AgentMessage(id: 1, role: "user", content: "报销要几天?", citations: nil),
                        AgentMessage(id: -2, role: "assistant", content: "一般", citations: nil),
                    ]
                    return s
                }()
            ) {
                AgentChatFeature()
            } withDependencies: {
                $0.agentAPI = .previewValue
            }
        )
    }
    .preferredColorScheme(.dark)
}
