import ComposableArchitecture
import SwiftUI

struct MeView: View {
    @Bindable var store: StoreOf<MeFeature>
    @Environment(ToastCenter.self) private var toast

    var body: some View {
        NavigationStack(path: $store.scope(state: \.path, action: \.path)) {
            ScrollView {
                VStack(spacing: 16) {
                    ProfileHeader(profile: store.profile) { store.send(.profileTapped) }

                    SettingsCard(items: [
                        SettingsItem(icon: "checkmark.bubble.fill", iconColor: WeChatColor.brand, title: "服务"),
                    ]) { _ in toast.show() }

                    SettingsCard(items: [
                        SettingsItem(icon: "star.square.fill", iconColor: Color(hex: 0xF5B838), title: "收藏"),
                        SettingsItem(icon: "photo.fill", iconColor: Color(hex: 0x3B7BF0), title: "朋友圈"),
                        SettingsItem(icon: "play.rectangle.fill", iconColor: Color(hex: 0x3B7BF0), title: "作品", detail: "添加第1个作品", showDot: true),
                        SettingsItem(icon: "wallet.pass.fill", iconColor: Color(hex: 0xEB6F43), title: "小店与卡包", detail: "[618优惠返场]小熊迷你多功能电饭煲", showDot: true),
                        SettingsItem(icon: "face.smiling.fill", iconColor: Color(hex: 0xF5B838), title: "表情"),
                    ]) { _ in toast.show() }

                    SettingsCard(items: [
                        SettingsItem(icon: "gearshape.fill", iconColor: Color(hex: 0x3B7BF0), title: "设置"),
                    ]) { _ in store.send(.settingsTapped) }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 24)
            }
            .background(WeChatColor.background)
            .toolbar(.hidden, for: .navigationBar)
            .task { store.send(.onAppear) }
        } destination: { store in
            switch store.case {
            case let .settings(store): SettingsView(store: store)
            case let .profile(store): ProfileView(store: store)
            case .appearance: AppearanceView()
            }
        }
    }
}

private struct ProfileHeader: View {
    let profile: MeProfile
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 16) {
                Avatar(url: profile.avatarURL, size: 64, cornerRadius: 8)
                VStack(alignment: .leading, spacing: 8) {
                    Text(profile.name)
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(WeChatColor.textPrimary)
                    HStack(spacing: 4) {
                        Text("微信号:\(profile.wxid)")
                            .font(.system(size: 14))
                            .foregroundStyle(WeChatColor.textSecondary)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11))
                            .foregroundStyle(WeChatColor.textTertiary)
                    }
                    HStack(spacing: 8) {
                        pill {
                            HStack(spacing: 3) {
                                Image(systemName: "plus").font(.system(size: 10))
                                Text("状态").font(.system(size: 12))
                            }
                        }
                        pill {
                            HStack(spacing: 4) {
                                Text("等\(profile.friendCount)个朋友").font(.system(size: 12))
                                Circle().fill(WeChatColor.badge).frame(width: 6, height: 6)
                            }
                        }
                    }
                    .foregroundStyle(WeChatColor.textSecondary)
                }
                Spacer()
                Image(systemName: "qrcode")
                    .font(.system(size: 18))
                    .foregroundStyle(WeChatColor.textSecondary)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13))
                    .foregroundStyle(WeChatColor.textTertiary)
            }
            .padding(16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("个人资料")
    }

    private func pill(@ViewBuilder _ content: () -> some View) -> some View {
        content()
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .overlay(Capsule().stroke(WeChatColor.separator, lineWidth: 1))
    }
}

#Preview {
    MeView(
        store: Store(initialState: MeFeature.State(profile: .sample)) {
            MeFeature()
        }
    )
    .environment(ToastCenter())
    .preferredColorScheme(.dark)
}
