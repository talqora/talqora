import SwiftUI
import UIKit

// 微信主题色板。每个语义令牌给「浅色 / 深色」两套值,用 UIColor(dynamicProvider:) 实现,
// 随当前外观(系统或 App 内手动设定)自动解析——所有 `WeChatColor.x` 调用点无需改动。
public enum WeChatColor {
    public static let brand = color(light: 0x07C160, dark: 0x07C160) // 微信品牌绿,明暗一致
    public static let background = color(light: 0xEDEDED, dark: 0x111111) // 页面底色
    public static let elevated = color(light: 0xFFFFFF, dark: 0x1E1E1E) // 分组/卡片/输入框底
    public static let navBar = color(light: 0xF7F7F7, dark: 0x1A1A1A) // 导航栏/标签栏底
    public static let separator = color(light: 0xE3E3E3, dark: 0x2A2A2A) // 分隔线
    public static let textPrimary = color(light: 0x191919, dark: 0xEDEDED) // 主文本
    public static let textSecondary = color(light: 0x888888, dark: 0x7F7F7F) // 次要文本
    public static let textTertiary = color(light: 0xB2B2B2, dark: 0x5A5A5A) // 占位/弱提示
    public static let badge = color(light: 0xFA5151, dark: 0xFA5151) // 未读红点,明暗一致
    public static let avatarPlaceholder = color(light: 0xD8D8D8, dark: 0x2C2C2C) // 头像占位底

    // 通话界面专用颜色 — 语音通话深色渐变背景(始终深色,与系统外观无关)
    public static let callBackgroundTop = Color(hex: 0x1A2035)
    public static let callBackgroundBottom = Color(hex: 0x0D1220)

    // 通话界面专用颜色 — 视频通话始终深色,与系统外观无关
    public static let videoSurface = Color.black          // RTCVideoView track=nil 时的黑底
    public static let videoScrim = Color.black            // 顶部渐变遮罩底色(保证字幕可读)
    public static let pipFill = Color.black.opacity(0.7)  // 本地 PiP 占位填充
    public static let pipStroke = Color.white.opacity(0.3) // 本地 PiP 描边

    private static func color(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: weChatDynamicUIColor(light: light, dark: dark))
    }
}

// 按当前 userInterfaceStyle 在浅/深之间解析的动态 UIColor。抽成自由函数便于单测(可对指定 trait 解析)。
public func weChatDynamicUIColor(light: UInt32, dark: UInt32) -> UIColor {
    UIColor { traits in
        UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
    }
}

// 字号令牌:统一排版,避免散落的 .font(.system(size:))。字号不随明暗变。
public enum WeChatFont {
    public static let title = Font.system(size: 22, weight: .semibold) // 页面大标题(如「我」页昵称)
    public static let navTitle = Font.system(size: 17, weight: .semibold) // 导航栏标题
    public static let body = Font.system(size: 16) // 正文/消息
    public static let subheadline = Font.system(size: 15) // 列表主标题
    public static let callout = Font.system(size: 14) // 次级标题/按钮
    public static let footnote = Font.system(size: 13) // 预览/说明
    public static let caption = Font.system(size: 12) // 时间/角标
    public static let caption2 = Font.system(size: 11) // 最弱提示

    // 通话界面图标尺寸令牌
    public static let callIconLarge = Font.system(size: 26, weight: .medium)  // 圆形大按钮内图标
    public static let callIconMedium = Font.system(size: 22, weight: .medium) // 方形切换按钮内图标
    public static let callIconPiP = Font.system(size: 28)                     // PiP 占位图标
}

// 间距令牌(pt)。
public enum WeChatSpacing {
    public static let xs: CGFloat = 4
    public static let s: CGFloat = 8
    public static let m: CGFloat = 12
    public static let l: CGFloat = 16
    public static let xl: CGFloat = 24
}

// 圆角令牌(pt)。
public enum WeChatRadius {
    public static let s: CGFloat = 6
    public static let m: CGFloat = 8
    public static let l: CGFloat = 10
}

extension Color {
    // 16 进制构造,便于直接用设计稿色值(0xRRGGBB)。
    public init(hex: UInt32, alpha: Double = 1) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}

extension UIColor {
    public convenience init(hex: UInt32, alpha: CGFloat = 1) {
        let r = CGFloat((hex >> 16) & 0xFF) / 255
        let g = CGFloat((hex >> 8) & 0xFF) / 255
        let b = CGFloat(hex & 0xFF) / 255
        self.init(red: r, green: g, blue: b, alpha: alpha)
    }
}
