import ComposableArchitecture
import Services
import DesignSystem
import SwiftUI

// 语音通话 panel:深色渐变背景 + 对端头像/昵称/状态 + 共享控制条。
struct VoiceCallPanel: View {
    @Bindable var store: StoreOf<CallFeature>

    var body: some View {
        ZStack {
            voiceBackground

            VStack(spacing: 0) {
                Spacer()

                peerInfo
                    .padding(.bottom, WeChatSpacing.xl)

                Spacer()

                CallControlBar(store: store)
            }
            .safeAreaPadding(.top, 60)
        }
    }

    // 深色渐变:让白色文字/控件在语音界面始终可读。
    private var voiceBackground: some View {
        LinearGradient(
            colors: [WeChatColor.callBackgroundTop, WeChatColor.callBackgroundBottom],
            startPoint: .top,
            endPoint: .bottom
        )
        .ignoresSafeArea()
    }

    private var peerInfo: some View {
        VStack(spacing: WeChatSpacing.l) {
            let avatarURL = store.peer.flatMap { URL(string: $0.avatar) }
            VoiceAvatar(url: avatarURL, size: 96)

            VStack(spacing: WeChatSpacing.s) {
                Text(store.peer?.nickname ?? "")
                    .font(WeChatFont.title)
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)

                Text(callStatusText(
                    phase: store.phase,
                    callType: store.callType,
                    durationSeconds: store.durationSeconds
                ))
                .font(WeChatFont.body)
                .foregroundStyle(.white.opacity(0.75))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            }
        }
    }
}

// MARK: - Previews

#Preview("语音振铃") {
    VoiceCallPanel(
        store: Store(
            initialState: CallFeature.State(
                phase: .incoming,
                callType: .voice,
                peer: CallUserDTO(id: 42, username: "alice", nickname: "Alice", avatar: ""),
                role: .callee,
                localUser: CallUserDTO(id: 1, username: "bob", nickname: "Bob", avatar: "")
            )
        ) { CallFeature() }
    )
}

#Preview("语音通话中") {
    VoiceCallPanel(
        store: Store(
            initialState: CallFeature.State(
                phase: .connected,
                callType: .voice,
                peer: CallUserDTO(id: 42, username: "alice", nickname: "Alice", avatar: ""),
                role: .caller,
                durationSeconds: 92,
                localUser: CallUserDTO(id: 1, username: "bob", nickname: "Bob", avatar: "")
            )
        ) { CallFeature() }
    )
    .preferredColorScheme(.dark)
}
