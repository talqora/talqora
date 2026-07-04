import ComposableArchitecture
import SwiftUI

// 好友资料页(图10):头像+昵称/微信号 头卡 → 朋友资料/朋友圈 → 底部 发消息/音视频通话。
struct ContactDetailView: View {
    @Bindable var store: StoreOf<ContactDetailFeature>
    @Environment(ToastCenter.self) private var toast

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                header
                Card {
                    NavRow(title: "朋友资料", subtitle: "添加朋友的备注名、电话、标签、备忘、照片等,并设置朋友权限") {
                        store.send(.settingsTapped)
                    }
                }
                Card {
                    NavRow(title: "朋友圈") { toast.show() }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)
        }
        .background(WeChatColor.background)
        .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // 二级页不保留底部 tab
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { store.send(.settingsTapped) } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(WeChatColor.textPrimary)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("好友设置")
            }
        }
    }

    private var header: some View {
        HStack(spacing: 16) {
            Avatar(url: store.contact.avatarURL, size: 64, cornerRadius: 8)
            VStack(alignment: .leading, spacing: 6) {
                Text(store.contact.name)
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(WeChatColor.textPrimary)
                    .lineLimit(1)
                if !store.contact.username.isEmpty {
                    Text("昵称:\(store.contact.username)")
                        .font(.system(size: 14))
                        .foregroundStyle(WeChatColor.textSecondary)
                        .lineLimit(1)
                }
                Text("微信号:\(store.contact.id)")
                    .font(.system(size: 14))
                    .foregroundStyle(WeChatColor.textSecondary)
                    .lineLimit(1)
            }
            Spacer()
        }
        .padding(16)
        .background(WeChatColor.elevated)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var actionBar: some View {
        HStack(spacing: 12) {
            ActionButton(icon: "message.fill", title: "发消息") { store.send(.messageTapped) }
            ActionButton(icon: "video.fill", title: "音视频通话") { toast.show() }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(WeChatColor.navBar)
    }
}

private struct Card<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 0) { content }
            .background(WeChatColor.elevated)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// 可点行:标题(+可选副标题)+ chevron;整行命中可点。
private struct NavRow: View {
    let title: LocalizedStringKey
    var subtitle: LocalizedStringKey?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 16))
                        .foregroundStyle(WeChatColor.textPrimary)
                    if let subtitle {
                        Text(subtitle)
                            .font(.system(size: 12))
                            .foregroundStyle(WeChatColor.textTertiary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WeChatColor.textTertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
    }
}

// 底部大按钮:图标 + 文案,填充绿色底。
private struct ActionButton: View {
    let icon: String
    let title: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 16))
                Text(title).font(.system(size: 16, weight: .medium))
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .background(WeChatColor.brand, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
    }
}

#Preview {
    NavigationStack {
        ContactDetailView(
            store: Store(
                initialState: ContactDetailFeature.State(
                    contact: Contact(id: "1024", name: "老段", username: "段宇皓", remark: "老段", sectionKey: "D")
                )
            ) {
                ContactDetailFeature()
            }
        )
    }
    .environment(ToastCenter())
    .preferredColorScheme(.dark)
}
