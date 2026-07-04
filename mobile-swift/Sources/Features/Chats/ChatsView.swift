import ComposableArchitecture
import SwiftUI

struct ChatsView: View {
    @Bindable var store: StoreOf<ChatsFeature>
    @Environment(ToastCenter.self) private var toast

    var body: some View {
        NavigationStack(path: $store.scope(state: \.path, action: \.path)) {
            AsyncStateView<Conversation, AnyView>(state: chatsViewState) { conversations in
                AnyView(conversationList(conversations))
            }
            .background(WeChatColor.background)
            .navigationTitle("微信")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 22) {
                        Button { store.send(.searchButtonTapped) } label: {
                            Image(systemName: "magnifyingglass")
                        }
                        .accessibilityLabel("搜索")
                        Button { toast.show() } label: { Image(systemName: "plus.circle") }
                            .accessibilityLabel("发起")
                    }
                    .font(.system(size: 18))
                    .foregroundStyle(WeChatColor.textPrimary)
                }
            }
            .fullScreenCover(item: $store.scope(state: \.search, action: \.search)) { searchStore in
                SearchView(store: searchStore)
            }
            .task { store.send(.onAppear) }
        } destination: { store in
            ChatDetailView(store: store)
        }
    }

    // 三态:加载中 / 空会话 / 加载失败(带重试);有数据即列表。
    private var chatsViewState: AsyncStateView<Conversation, AnyView>.State {
        if store.isLoading && store.conversations.isEmpty { return .loading }
        if let error = store.loadError, store.conversations.isEmpty {
            return .failed(error, retry: { store.send(.reloadTapped) })
        }
        if store.conversations.isEmpty { return .empty("暂无会话") }
        return .loaded(store.conversations)
    }

    private func conversationList(_ conversations: [Conversation]) -> some View {
        List {
            if store.otherDeviceCount > 0 {
                DeviceBanner(count: store.otherDeviceCount)
                    .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    .listRowBackground(WeChatColor.background)
                    .listRowSeparatorTint(WeChatColor.separator)
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 60 }
            }
            ForEach(conversations) { conversation in
                Button { store.send(.conversationTapped(conversation)) } label: {
                    ConversationRow(conversation: conversation)
                }
                .buttonStyle(.plain)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .listRowBackground(WeChatColor.background)
                .listRowSeparatorTint(WeChatColor.separator)
                .alignmentGuide(.listRowSeparatorLeading) { _ in 60 }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }
}

private struct DeviceBanner: View {
    let count: Int

    var body: some View {
        HStack(spacing: 12) {
            IconTile(systemName: "laptopcomputer", color: Color(hex: 0x3A3A3A), size: 40, cornerRadius: 5)
            Text("已登录\(count)台其他设备")
                .font(.system(size: 15))
                .foregroundStyle(WeChatColor.textSecondary)
            Spacer()
        }
        .padding(.vertical, 10)
    }
}

private struct ConversationRow: View {
    let conversation: Conversation

    var body: some View {
        HStack(spacing: 12) {
            avatar
                .frame(width: 48, height: 48)
                .overlay(alignment: .topTrailing) { unreadBadge }
            VStack(alignment: .leading, spacing: 4) {
                Text(conversation.title)
                    .font(.system(size: 16))
                    .foregroundStyle(WeChatColor.textPrimary)
                    .lineLimit(1)
                Text(conversation.preview)
                    .font(.system(size: 13))
                    .foregroundStyle(WeChatColor.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                Text(conversation.timeText)
                    .font(.system(size: 12))
                    .foregroundStyle(WeChatColor.textTertiary)
                if conversation.isMuted {
                    Image(systemName: "bell.slash.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(WeChatColor.textTertiary)
                }
            }
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle()) // 整行(含 Spacer/内边距)命中区可点,而非仅头像/文字
    }

    @ViewBuilder private var avatar: some View {
        switch conversation.systemTile {
        case .fileTransfer:
            IconTile(systemName: "folder.fill", color: WeChatColor.brand)
        case .none:
            Avatar(url: conversation.avatarURL)
        }
    }

    @ViewBuilder private var unreadBadge: some View {
        if conversation.unreadCount > 0 {
            Text("\(min(conversation.unreadCount, 99))")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .frame(minWidth: 18, minHeight: 18)
                .background(WeChatColor.badge, in: Capsule())
                .offset(x: 6, y: -6)
        } else if conversation.hasRedDot {
            Circle()
                .fill(WeChatColor.badge)
                .frame(width: 9, height: 9)
                .overlay(Circle().stroke(WeChatColor.background, lineWidth: 1.5))
                .offset(x: 3, y: -3)
        }
    }
}

#Preview {
    ChatsView(
        store: Store(initialState: ChatsFeature.State()) {
            ChatsFeature()
        }
    )
    .environment(ToastCenter())
    .preferredColorScheme(.dark)
}
