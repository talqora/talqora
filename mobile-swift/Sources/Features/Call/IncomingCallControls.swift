import ComposableArchitecture
import DesignSystem
import SwiftUI

// 被叫振铃控制区:拒绝(红) + 接受(绿)
struct IncomingCallControls: View {
    @Bindable var store: StoreOf<CallFeature>
    let onHaptic: () -> Void

    var body: some View {
        HStack(spacing: 48) {
            Spacer()
            CallCircleButton(
                systemName: "phone.down.fill",
                label: "拒绝",
                tint: WeChatColor.badge,
                isActive: false
            ) {
                onHaptic()
                store.send(.rejectTapped)
            }
            CallCircleButton(
                systemName: "phone.fill",
                label: "接受",
                tint: WeChatColor.brand,
                isActive: false
            ) {
                onHaptic()
                store.send(.acceptTapped)
            }
            Spacer()
        }
    }
}
