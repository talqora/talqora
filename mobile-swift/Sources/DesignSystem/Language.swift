import Foundation

// 语言模式:跟随系统 / 中文 / English。持久化在 @AppStorage("appLanguage"),
// AppView 据此设 environment locale,SwiftUI 的 Text/Button/标题/占位/Alert 等
// LocalizedStringKey 会按此 locale 查 Localizable.xcstrings 实时切换。
public enum LanguageMode: String, CaseIterable, Sendable {
    case system
    case zh
    case en

    // nil = 跟随系统(用设备语言)。
    public var locale: Locale? {
        switch self {
        case .system: nil
        case .zh: Locale(identifier: "zh-Hans")
        case .en: Locale(identifier: "en")
        }
    }
}
