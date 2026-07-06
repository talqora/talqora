import SwiftUI

// 外观模式:跟随系统 / 强制浅色 / 强制深色。持久化在 @AppStorage,根视图据此设 preferredColorScheme。
public enum AppearanceMode: String, CaseIterable, Sendable {
    case system
    case light
    case dark

    // nil = 跟随系统(不覆盖 colorScheme)。
    public var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    // LocalizedStringKey:Picker 里 Text(mode.label) 随语言令牌本地化。
    public var label: LocalizedStringKey {
        switch self {
        case .system: "跟随系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }
}
