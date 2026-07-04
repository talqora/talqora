import ComposableArchitecture
import SwiftUI

struct NewFriendsView: View {
    @Bindable var store: StoreOf<NewFriendsFeature>

    var body: some View {
        Group {
            if store.isLoading && store.requests.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.loadError, store.requests.isEmpty {
                ContentUnavailableView {
                    Label("加载失败", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(LocalizedStringKey(error))
                } actions: {
                    Button("重试") { store.send(.reloadTapped) }
                        .buttonStyle(PressableButtonStyle())
                }
            } else if store.requests.isEmpty {
                ContentUnavailableView("暂无新的朋友请求", systemImage: "person.crop.circle.badge.plus")
            } else {
                List {
                    ForEach(store.requests) { request in
                        RequestRow(
                            request: request,
                            onAccept: { store.send(.acceptTapped(peerId: request.peerId)) },
                            onReject: { store.send(.rejectTapped(peerId: request.peerId)) }
                        )
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
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WeChatColor.background)
        .navigationTitle("新的朋友")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // 二级页不保留底部 tab
        .alert($store.scope(state: \.alert, action: \.alert))
        .task { store.send(.onAppear) }
    }
}

private struct RequestRow: View {
    let request: FriendRequest
    let onAccept: () -> Void
    let onReject: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Avatar(url: request.avatarURL, size: 44)
            Text(request.username)
                .font(.system(size: 16))
                .foregroundStyle(WeChatColor.textPrimary)
                .lineLimit(1)
            Spacer()
            trailing
        }
        .padding(.vertical, 9)
    }

    @ViewBuilder private var trailing: some View {
        switch request.status {
        case .pending:
            HStack(spacing: 8) {
                Button(action: onReject) {
                    Text("拒绝")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(WeChatColor.textSecondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(WeChatColor.elevated, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .buttonStyle(PressableButtonStyle())
                Button(action: onAccept) {
                    Text("接受")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(WeChatColor.brand, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .buttonStyle(PressableButtonStyle())
            }
        case .sent:
            statusText("等待验证")
        case .accepted:
            statusText("已添加")
        case .blocked:
            statusText("已拒绝")
        }
    }

    private func statusText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 14))
            .foregroundStyle(WeChatColor.textSecondary)
    }
}

#Preview {
    NavigationStack {
        NewFriendsView(
            store: Store(initialState: NewFriendsFeature.State()) {
                NewFriendsFeature()
            } withDependencies: {
                $0.friendRequestClient = .previewValue
            }
        )
    }
    .preferredColorScheme(.dark)
}
