import SwiftUI

// 功能面板里的单个磁贴:圆角方块图标 + 下方文字标签(微信「+」面板样式)。
// 整块可点,命中区 ≥44pt,套 PressableButtonStyle 保证按下反馈。
struct ChatFunctionTile: View {
    let systemImage: String
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: WeChatSpacing.s) {
                Image(systemName: systemImage)
                    .font(.system(size: 26))
                    .foregroundStyle(WeChatColor.textPrimary)
                    .frame(width: 56, height: 56)
                    .background(WeChatColor.elevated, in: RoundedRectangle(cornerRadius: WeChatRadius.l, style: .continuous))
                Text(title)
                    .font(WeChatFont.caption)
                    .foregroundStyle(WeChatColor.textSecondary)
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(title)
    }
}
