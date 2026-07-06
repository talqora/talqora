import SwiftUI
import DesignSystem
import Testing
import UIKit
@testable import OurChat

struct ThemeTests {
    @Test
    func appearanceModeMapsToColorScheme() {
        #expect(AppearanceMode.system.colorScheme == nil)
        #expect(AppearanceMode.light.colorScheme == .light)
        #expect(AppearanceMode.dark.colorScheme == .dark)
    }

    @Test
    func dynamicColorResolvesDifferentlyPerAppearance() {
        let color = weChatDynamicUIColor(light: 0xEDEDED, dark: 0x111111)
        let light = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .light))
        let dark = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
        #expect(light != dark) // 明暗不同值 → 确实随外观自适应
        #expect(rgb(light) == (0xED, 0xED, 0xED))
        #expect(rgb(dark) == (0x11, 0x11, 0x11))
    }

    @Test
    func uiColorHexDecodesComponents() {
        #expect(rgb(UIColor(hex: 0x07C160)) == (0x07, 0xC1, 0x60))
    }

    private func rgb(_ color: UIColor) -> (Int, Int, Int) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        return (Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
    }
}
