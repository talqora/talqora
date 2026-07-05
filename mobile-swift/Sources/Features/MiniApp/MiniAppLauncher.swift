import SwiftUI

/// 小程序启动面板 — 微信小程序风格的磁贴列表。
/// 调用方传入 `onOpen` 回调；此视图自身不持有任何 store，纯 UI 。
struct MiniAppLauncher: View {
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: WeChatSpacing.m) {
            Text("小程序")
                .font(WeChatFont.subheadline)
                .foregroundStyle(WeChatColor.textSecondary)
                .padding(.horizontal, WeChatSpacing.l)
                .padding(.top, WeChatSpacing.l)

            LazyVGrid(
                columns: [
                    GridItem(.adaptive(minimum: 64, maximum: 80), spacing: WeChatSpacing.xl)
                ],
                spacing: WeChatSpacing.xl
            ) {
                MiniAppTile(
                    systemImage: "sparkles",
                    name: "知识库助手",
                    onTap: onOpen
                )
            }
            .padding(.horizontal, WeChatSpacing.xl)
            .padding(.bottom, WeChatSpacing.xl)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WeChatColor.elevated)
    }
}

private struct MiniAppTile: View {
    let systemImage: String
    let name: String
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: WeChatSpacing.s) {
                Image(systemName: systemImage)
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(minWidth: 56, minHeight: 56)
                    .background(WeChatColor.brand, in: RoundedRectangle(cornerRadius: WeChatRadius.l))
                    .contentShape(Rectangle())

                Text(name)
                    .font(WeChatFont.caption)
                    .foregroundStyle(WeChatColor.textSecondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(name)
        .accessibilityAddTraits(.isButton)
    }
}

#Preview("浅色") {
    MiniAppLauncher(onOpen: {})
        .background(WeChatColor.background)
}

#Preview("深色") {
    MiniAppLauncher(onOpen: {})
        .preferredColorScheme(.dark)
        .background(WeChatColor.background)
}
