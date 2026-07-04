import ComposableArchitecture
import SwiftUI

// 设置页(图13-15):顶部搜索 + 账号/通用/功能/帮助与关于 分组 + 切换账号/退出登录。
// 真实:个人资料、界面与显示、退出登录;其余占位弹 toast。
struct SettingsView: View {
    @Bindable var store: StoreOf<SettingsFeature>
    @Environment(ToastCenter.self) private var toast

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                searchBar

                section("账号") {
                    Card {
                        Row(title: "个人资料") { store.send(.profileTapped) }
                        Divider()
                        Row(title: "账号安全") { toast.show() }
                        Divider()
                        Row(title: "个人信息与权限") { toast.show() }
                    }
                }

                section("通用") {
                    Card {
                        Row(title: "通知") { toast.show() }
                        Divider()
                        Row(title: "界面与显示") { store.send(.appearanceTapped) }
                        Divider()
                        Row(title: "朋友权限") { toast.show() }
                        Divider()
                        Row(title: "存储空间") { toast.show() }
                        Divider()
                        Row(title: "更多") { toast.show() }
                    }
                }

                section("功能") {
                    Card {
                        Row(title: "聊天") { toast.show() }
                        Divider()
                        Row(title: "音视频通话") { toast.show() }
                        Divider()
                        Row(title: "聊天记录管理") { toast.show() }
                        Divider()
                        Row(title: "其他功能") { toast.show() }
                        Divider()
                        Row(title: "插件", detail: "输入法「语音转文字」全面升级") { toast.show() }
                    }
                }

                section("帮助与关于") {
                    Card {
                        Row(title: "帮助与反馈") { toast.show() }
                        Divider()
                        Row(title: "关于微信", detail: "版本 8.0.69") { toast.show() }
                    }
                }

                Card { Row(title: "切换账号") { toast.show() } }

                Card {
                    Button { store.send(.logoutTapped) } label: {
                        Text("退出登录")
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
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // 二级页不保留底部 tab
    }

    private var searchBar: some View {
        Button { toast.show() } label: {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(WeChatColor.textTertiary)
                Text("搜索").foregroundStyle(WeChatColor.textTertiary)
                Spacer()
            }
            .font(.system(size: 15))
            .padding(.horizontal, 10)
            .frame(height: 36)
            .background(WeChatColor.elevated)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
    }

    private func section(_ title: LocalizedStringKey, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 13))
                .foregroundStyle(WeChatColor.textSecondary)
                .padding(.leading, 4)
            content()
        }
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

private struct Divider: View {
    var body: some View {
        Rectangle().fill(WeChatColor.separator).frame(height: 0.5).padding(.leading, 16)
    }
}

private struct Row: View {
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
                        .font(.system(size: 13))
                        .foregroundStyle(WeChatColor.textSecondary)
                        .lineLimit(1)
                        .frame(maxWidth: 200, alignment: .trailing)
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

#Preview {
    NavigationStack {
        SettingsView(
            store: Store(initialState: SettingsFeature.State()) {
                SettingsFeature()
            }
        )
    }
    .environment(ToastCenter())
    .preferredColorScheme(.dark)
}
