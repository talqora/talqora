import SwiftUI

// 微信「我 / 发现」用的圆角分组卡片。数据驱动:一组 SettingsItem 渲染成一张卡,行间细分隔线缩进到标题。
public struct SettingsItem: Identifiable, Equatable {
    public let id = UUID()
    public var icon: String
    public var iconColor: Color
    public var title: LocalizedStringKey // 随语言令牌本地化
    public var detail: String?
    public var showDot: Bool

    public init(icon: String, iconColor: Color, title: LocalizedStringKey, detail: String? = nil, showDot: Bool = false) {
        self.icon = icon
        self.iconColor = iconColor
        self.title = title
        self.detail = detail
        self.showDot = showDot
    }
}

public struct SettingsCard: View {
    let items: [SettingsItem]
    var onTap: (SettingsItem) -> Void

    public init(items: [SettingsItem], onTap: @escaping (SettingsItem) -> Void = { _ in }) {
        self.items = items
        self.onTap = onTap
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                Button { onTap(item) } label: { SettingsRow(item: item) }
                    .buttonStyle(.plain)
                if item.id != items.last?.id {
                    Rectangle()
                        .fill(WeChatColor.separator)
                        .frame(height: 0.5)
                        .padding(.leading, 56)
                }
            }
        }
        .background(WeChatColor.elevated)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

public struct SettingsRow: View {
    let item: SettingsItem

    public init(item: SettingsItem) {
        self.item = item
    }

    public var body: some View {
        HStack(spacing: 12) {
            Image(systemName: item.icon)
                .font(.system(size: 20))
                .foregroundStyle(item.iconColor)
                .frame(width: 28, height: 28)
            Text(item.title)
                .font(.system(size: 16))
                .foregroundStyle(WeChatColor.textPrimary)
            Spacer(minLength: 8)
            if let detail = item.detail {
                Text(detail)
                    .font(.system(size: 14))
                    .foregroundStyle(WeChatColor.textSecondary)
                    .lineLimit(1)
                    .frame(maxWidth: 180, alignment: .trailing)
            }
            if item.showDot {
                Circle().fill(WeChatColor.badge).frame(width: 8, height: 8)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(WeChatColor.textTertiary)
        }
        .padding(.horizontal, 16)
        .frame(height: 53)
        .contentShape(Rectangle())
    }
}
