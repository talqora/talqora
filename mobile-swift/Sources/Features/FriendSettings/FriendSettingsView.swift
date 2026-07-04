import ComposableArchitecture
import SwiftUI

// 朋友设置页(图11):无图标的纯文本分组行 + 两个占位开关 + 红色删除。
struct FriendSettingsView: View {
    @Bindable var store: StoreOf<FriendSettingsFeature>
    @Environment(ToastCenter.self) private var toast
    @State private var starred = false
    @State private var blocked = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                // 设置朋友资料(真实:进入备注编辑)
                Card {
                    NavRow(title: "设置朋友资料", detail: store.contact.name) {
                        store.send(.setRemarkTapped)
                    }
                }

                Card {
                    NavRow(title: "朋友权限") { toast.show() }
                    Divider()
                    NavRow(title: recommendTitle) { toast.show() }
                    Divider()
                    NavRow(title: "添加到桌面") { toast.show() }
                }

                Card {
                    ToggleRow(title: "设为星标朋友", isOn: $starred)
                        .onChange(of: starred) { toast.show() }
                    Divider()
                    ToggleRow(title: "加入黑名单", isOn: $blocked)
                        .onChange(of: blocked) { toast.show() }
                }

                Card {
                    NavRow(title: "投诉") { toast.show() }
                }

                Card {
                    Button { toast.show() } label: {
                        Text("删除")
                            .font(.system(size: 16))
                            .foregroundStyle(WeChatColor.badge)
                            .frame(maxWidth: .infinity)
                            .frame(height: 53)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressableButtonStyle())
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 16)
        }
        .background(WeChatColor.background)
        .navigationTitle("朋友设置")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // 二级页不保留底部 tab
    }

    // 「把 TA 推荐给朋友」——避免臆断性别,统一用中性文案。
    private var recommendTitle: LocalizedStringKey { "把 TA 推荐给朋友" }
}

// 纯文本分组卡:elevated 底 + 圆角,内部由调用方塞行 + Divider。
private struct Card<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 0) { content }
            .background(WeChatColor.elevated)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

private struct Divider: View {
    var body: some View {
        Rectangle()
            .fill(WeChatColor.separator)
            .frame(height: 0.5)
            .padding(.leading, 16)
    }
}

// 可点导航行:左标题 + 右副文案 + chevron;整行命中区可点。
private struct NavRow: View {
    let title: LocalizedStringKey
    var detail: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 16))
                    .foregroundStyle(WeChatColor.textPrimary)
                Spacer(minLength: 8)
                if let detail {
                    Text(detail)
                        .font(.system(size: 15))
                        .foregroundStyle(WeChatColor.textSecondary)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WeChatColor.textTertiary)
            }
            .padding(.horizontal, 16)
            .frame(height: 53)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
    }
}

// 开关行:占位,切换即弹提示(无服务端持久化)。
private struct ToggleRow: View {
    let title: LocalizedStringKey
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            Text(title)
                .font(.system(size: 16))
                .foregroundStyle(WeChatColor.textPrimary)
        }
        .tint(WeChatColor.brand)
        .padding(.horizontal, 16)
        .frame(height: 53)
    }
}

#Preview {
    NavigationStack {
        FriendSettingsView(
            store: Store(
                initialState: FriendSettingsFeature.State(
                    contact: Contact(id: "1024", name: "艾芳", username: "艾芳", sectionKey: "A")
                )
            ) {
                FriendSettingsFeature()
            }
        )
    }
    .environment(ToastCenter())
    .preferredColorScheme(.dark)
}
