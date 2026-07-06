import SwiftUI
import UIKit

extension View {
    /// 点当前页面空白处收起键盘。挂在页面容器上即可;SwiftUI 按钮/输入框手势优先级更高,不会吞掉它们的点击。
    /// 容器需可命中(有 background 或 contentShape),空白区才收得到点击。
    public func dismissKeyboardOnTap() -> some View {
        onTapGesture {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
            )
        }
    }
}
