import SwiftUI
import DesignSystem

// 圆形大按钮:接受 / 拒绝 / 挂断
struct CallCircleButton: View {
    let systemName: String
    let label: String
    let tint: Color
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Circle()
                    .fill(tint)
                    .frame(width: 64, height: 64)
                    .overlay {
                        Image(systemName: systemName)
                            .font(WeChatFont.callIconLarge)
                            .foregroundStyle(.white)
                    }
                Text(label)
                    .font(WeChatFont.footnote)
                    .foregroundStyle(.white)
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(label)
    }
}
