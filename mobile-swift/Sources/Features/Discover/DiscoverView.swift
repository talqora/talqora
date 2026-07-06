import SwiftUI
import DesignSystem

// 发现页为静态入口聚合,无业务状态,直接用普通 SwiftUI 视图(不挂 TCA reducer)。全部为占位入口。
public struct DiscoverView: View {
    @Environment(ToastCenter.self) private var toast

    public init() {}

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    SettingsCard(items: [
                        SettingsItem(icon: "camera.fill", iconColor: Color(hex: 0x3B7BF0), title: "朋友圈", showDot: true),
                    ]) { _ in toast.show() }
                    SettingsCard(items: [
                        SettingsItem(icon: "play.circle.fill", iconColor: Color(hex: 0xEB6F43), title: "视频号"),
                        SettingsItem(icon: "dot.radiowaves.left.and.right", iconColor: Color(hex: 0xEB6F43), title: "直播"),
                    ]) { _ in toast.show() }
                    SettingsCard(items: [
                        SettingsItem(icon: "qrcode.viewfinder", iconColor: Color(hex: 0x3B7BF0), title: "扫一扫"),
                        SettingsItem(icon: "iphone.radiowaves.left.and.right", iconColor: Color(hex: 0x3B7BF0), title: "摇一摇"),
                    ]) { _ in toast.show() }
                    SettingsCard(items: [
                        SettingsItem(icon: "eye.fill", iconColor: Color(hex: 0xEB6F43), title: "看一看"),
                        SettingsItem(icon: "text.magnifyingglass", iconColor: Color(hex: 0xEB6F43), title: "搜一搜"),
                    ]) { _ in toast.show() }
                    SettingsCard(items: [
                        SettingsItem(icon: "location.fill", iconColor: Color(hex: 0x3B7BF0), title: "附近"),
                    ]) { _ in toast.show() }
                    SettingsCard(items: [
                        SettingsItem(icon: "cart.fill", iconColor: Color(hex: 0xEB6F43), title: "购物"),
                        SettingsItem(icon: "gamecontroller.fill", iconColor: Color(hex: 0x3B7BF0), title: "游戏"),
                    ]) { _ in toast.show() }
                    SettingsCard(items: [
                        SettingsItem(icon: "square.grid.2x2.fill", iconColor: Color(hex: 0x3B7BF0), title: "小程序"),
                    ]) { _ in toast.show() }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 16)
            }
            .background(WeChatColor.background)
            .navigationTitle("发现")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(WeChatColor.navBar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
        }
    }
}

#Preview {
    DiscoverView()
        .environment(ToastCenter())
        .preferredColorScheme(.dark)
}
