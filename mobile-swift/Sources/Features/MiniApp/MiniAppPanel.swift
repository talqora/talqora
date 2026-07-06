import SwiftUI
import DesignSystem

/// 小程序全屏面板 —— 聊天主页下拉过阈值后呈现(微信「最近使用的小程序」页)。
/// 纯 UI:`onOpen` 磁贴点击回调,`onClose` 收起(拖回主页 / 点顶部收起标)。
public struct MiniAppPanel: View {
    let onOpen: () -> Void
    let onClose: () -> Void

    public init(onOpen: @escaping () -> Void, onClose: @escaping () -> Void) {
        self.onOpen = onOpen
        self.onClose = onClose
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                MiniAppLauncher(onOpen: onOpen)
                    .padding(.top, WeChatSpacing.s)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(WeChatColor.background)
    }

    private var header: some View {
        ZStack {
            Text("最近")
                .font(WeChatFont.navTitle)
                .foregroundStyle(WeChatColor.textPrimary)
            HStack {
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "chevron.compact.up")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(WeChatColor.textSecondary)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel("收起小程序面板")
            }
        }
        .padding(.horizontal, WeChatSpacing.m)
        .padding(.top, WeChatSpacing.s)
    }
}

#Preview {
    MiniAppPanel(onOpen: {}, onClose: {})
        .preferredColorScheme(.dark)
}
