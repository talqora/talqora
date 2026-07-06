import ComposableArchitecture
import DesignSystem
import SwiftUI

// 控制条按阶段切换:incoming 时显示接受+拒绝,其余显示各功能按钮+挂断。
struct CallControlBar: View {
    @Bindable var store: StoreOf<CallFeature>

    // 用来触发触觉反馈的累计值,每次 accept/hangup 触发时 +1。
    @State private var hapticTrigger = 0

    var body: some View {
        VStack(spacing: 0) {
            if store.phase == .incoming {
                IncomingCallControls(store: store) { hapticTrigger += 1 }
            } else {
                ActiveCallControls(store: store) { hapticTrigger += 1 }
            }
        }
        .padding(.horizontal, WeChatSpacing.xl)
        .padding(.bottom, WeChatSpacing.xl)
        .sensoryFeedback(.impact, trigger: hapticTrigger)
    }
}
