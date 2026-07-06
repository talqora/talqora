import SwiftUI
import DesignSystem

// 方形切换按钮:静音 / 扬声器 / 摄像头 / 翻转
struct CallToggleButton: View {
    let systemName: String
    let label: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                RoundedRectangle(cornerRadius: WeChatRadius.m)
                    .fill(isActive ? Color.white.opacity(0.9) : Color.white.opacity(0.2))
                    .frame(width: 56, height: 56)
                    .overlay {
                        Image(systemName: systemName)
                            .font(WeChatFont.callIconMedium)
                            .foregroundStyle(isActive ? Color.black : Color.white)
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
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
