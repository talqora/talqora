import ComposableArchitecture
import SwiftUI

struct AgentChatListView: View {
    @Bindable var store: StoreOf<AgentChatFeature>

    var body: some View {
        NavigationStack {
            content
                .background(WeChatColor.background)
                .navigationTitle("对话")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            store.send(.createTapped)
                        } label: {
                            Image(systemName: "square.and.pencil")
                                .frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(PressableButtonStyle())
                        .accessibilityLabel("新建对话")
                    }
                }
                .navigationDestination(
                    isPresented: Binding(
                        get: { store.currentConversationId != nil },
                        set: { if !$0 { store.send(.dismissDetail) } }
                    )
                ) {
                    AgentChatDetailView(store: store)
                }
                .task { store.send(.onAppear) }
        }
        .tint(WeChatColor.brand)
    }

    @ViewBuilder
    private var content: some View {
        switch store.listPhase {
        case .idle, .loading:
            AsyncStateView<AgentConversation, EmptyView>(state: .loading) { _ in EmptyView() }
        case .empty:
            AsyncStateView<AgentConversation, EmptyView>(
                state: .empty("还没有对话,点右上 + 新建")
            ) { _ in EmptyView() }
        case .failed:
            AsyncStateView<AgentConversation, EmptyView>(
                state: .failed(store.errorMessage ?? "会话加载失败,请重试") {
                    store.send(.loadConversations)
                }
            ) { _ in EmptyView() }
        case .loaded:
            conversationList
        }
    }

    private var conversationList: some View {
        List {
            ForEach(store.conversations) { conversation in
                Button {
                    store.send(.select(conversation.id))
                } label: {
                    ConversationRow(conversation: conversation)
                }
                .buttonStyle(PressableButtonStyle())
                .listRowBackground(WeChatColor.elevated)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        store.send(.deleteTapped(conversation.id))
                    } label: {
                        Label("删除", systemImage: "trash")
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(WeChatColor.background)
    }
}

private struct ConversationRow: View {
    let conversation: AgentConversation

    var body: some View {
        HStack(spacing: WeChatSpacing.m) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(WeChatFont.body)
                .foregroundStyle(WeChatColor.brand)
                .frame(width: 40, height: 40)
                .background(WeChatColor.brand.opacity(0.12), in: RoundedRectangle(cornerRadius: WeChatRadius.l, style: .continuous))
            Text(conversation.title.isEmpty ? "新对话" : conversation.title)
                .font(WeChatFont.subheadline)
                .foregroundStyle(WeChatColor.textPrimary)
                .lineLimit(1)
            Spacer(minLength: WeChatSpacing.s)
            Image(systemName: "chevron.right")
                .font(WeChatFont.caption)
                .foregroundStyle(WeChatColor.textTertiary)
        }
        .padding(.vertical, WeChatSpacing.xs)
        .contentShape(Rectangle())
    }
}

#Preview("列表") {
    AgentChatListView(
        store: Store(
            initialState: {
                var s = AgentChatFeature.State()
                s.listPhase = .loaded
                s.conversations = [
                    AgentConversation(id: 1, title: "关于合同条款的问题", messages: nil),
                    AgentConversation(id: 2, title: "报销流程怎么走", messages: nil),
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

#Preview("空态") {
    AgentChatListView(
        store: Store(
            initialState: {
                var s = AgentChatFeature.State()
                s.listPhase = .empty
                return s
            }()
        ) {
            AgentChatFeature()
        } withDependencies: {
            $0.agentAPI = .previewValue
        }
    )
    .preferredColorScheme(.dark)
}
