import SwiftUI
import DesignSystem

/// 小程序**公共容器**:提供项目级的顶部 chrome(标题 + 关闭/更多 胶囊),
/// 与小程序本体在布局上解耦——本体只负责填充 `content`,无需感知关闭按钮,
/// 因此不会再出现「小程序内功能与关闭按钮重合」的问题。
///
/// 顶栏独占一行(非浮层覆盖),本体在其下方布局;未来接入其它小程序复用同一容器。
struct MiniAppContainer<Content: View>: View {
    let title: String
    var onMore: (() -> Void)?
    let onClose: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            topBar
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(WeChatColor.background)
    }

    private var topBar: some View {
        ZStack {
            Text(title)
                .font(WeChatFont.navTitle)
                .foregroundStyle(WeChatColor.textPrimary)
                .lineLimit(1)
            HStack {
                Spacer()
                capsule
            }
        }
        .frame(height: 44)
        .padding(.horizontal, WeChatSpacing.m)
        .background(WeChatColor.navBar)
        .overlay(alignment: .bottom) {
            Rectangle().fill(WeChatColor.separator).frame(height: 0.5)
        }
    }

    private var capsule: some View {
        HStack(spacing: 0) {
            if let onMore {
                capsuleButton("ellipsis", label: "更多", action: onMore)
                Rectangle().fill(WeChatColor.separator).frame(width: 0.5, height: 16)
            }
            capsuleButton("xmark", label: "关闭", action: onClose)
        }
        .frame(height: 32) // 视觉胶囊高度;按钮命中区 44 会向上下溢出到顶栏内(见下)
        .background(Capsule(style: .continuous).fill(WeChatColor.elevated))
        .overlay(Capsule(style: .continuous).stroke(WeChatColor.separator, lineWidth: 0.5))
    }

    // 视觉在 32 胶囊内,命中区 44×44(满足触摸目标下限),多出的高度落在顶栏留白里。
    private func capsuleButton(_ systemName: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(WeChatColor.textPrimary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(label)
    }
}

#Preview {
    MiniAppContainer(title: "知识库助手", onMore: {}, onClose: {}) {
        Color.clear.overlay(Text("小程序本体").foregroundStyle(WeChatColor.textSecondary))
    }
    .preferredColorScheme(.dark)
}
