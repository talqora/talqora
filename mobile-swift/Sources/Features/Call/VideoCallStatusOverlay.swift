import ComposableArchitecture
import SwiftUI

// 对端昵称 + 状态叠加在视频顶部,带渐变保证可读性。
struct VideoCallStatusOverlay: View {
    @Bindable var store: StoreOf<CallFeature>

    var body: some View {
        VStack {
            LinearGradient(
                colors: [WeChatColor.videoScrim.opacity(0.55), Color.clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 140)
            .ignoresSafeArea(edges: .top)
            .overlay(alignment: .topLeading) {
                VStack(alignment: .leading, spacing: WeChatSpacing.xs) {
                    Text(store.peer?.nickname ?? "")
                        .font(WeChatFont.navTitle)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)

                    Text(callStatusText(
                        phase: store.phase,
                        callType: store.callType,
                        durationSeconds: store.durationSeconds
                    ))
                    .font(WeChatFont.footnote)
                    .foregroundStyle(.white.opacity(0.8))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                }
                .padding(.horizontal, WeChatSpacing.l)
                .padding(.top, 60) // 安全区顶部距离
            }

            Spacer()
        }
    }
}
