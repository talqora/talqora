import ComposableArchitecture
import Services
import Models
import SwiftUI

// 通话全屏壳:根据 callType 分发到语音/视频 panel,共享底部控制条。
public struct CallView: View {
    @Bindable var store: StoreOf<CallFeature>

    public init(store: StoreOf<CallFeature>) {
        self.store = store
    }

    public var body: some View {
        ZStack {
            if store.callType == .video || store.hasRemoteVideo {
                VideoCallPanel(store: store)
            } else {
                VoiceCallPanel(store: store)
            }
        }
        .ignoresSafeArea()
    }
}

// MARK: - 状态文本

// 将通话阶段 + 类型映射为人读文本。
func callStatusText(phase: CallPhase, callType: CallType, durationSeconds: Int) -> String {
    switch phase {
    case .outgoing:
        return "正在呼叫…"
    case .incoming:
        return callType == .video ? "邀请你视频通话" : "邀请你语音通话"
    case .connecting:
        return "连接中…"
    case .connected:
        let m = durationSeconds / 60
        let s = durationSeconds % 60
        return String(format: "%02d:%02d", m, s)
    case .reconnecting:
        return "重连中…"
    case let .ended(reason):
        return reason
    case .idle:
        return ""
    }
}

// MARK: - Previews

#Preview("呼入语音") {
    CallView(
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
    CallView(
        store: Store(
            initialState: CallFeature.State(
                phase: .connected,
                callType: .voice,
                peer: CallUserDTO(id: 42, username: "alice", nickname: "Alice", avatar: ""),
                role: .caller,
                durationSeconds: 75,
                localUser: CallUserDTO(id: 1, username: "bob", nickname: "Bob", avatar: "")
            )
        ) { CallFeature() }
    )
}

#Preview("呼入视频") {
    CallView(
        store: Store(
            initialState: CallFeature.State(
                phase: .incoming,
                callType: .video,
                peer: CallUserDTO(id: 42, username: "alice", nickname: "Alice", avatar: ""),
                role: .callee,
                localUser: CallUserDTO(id: 1, username: "bob", nickname: "Bob", avatar: "")
            )
        ) { CallFeature() }
    )
}

#Preview("视频通话中") {
    CallView(
        store: Store(
            initialState: CallFeature.State(
                phase: .connected,
                callType: .video,
                peer: CallUserDTO(id: 42, username: "alice", nickname: "Alice", avatar: ""),
                role: .caller,
                isCameraOn: true,
                hasRemoteVideo: true,
                durationSeconds: 123,
                localUser: CallUserDTO(id: 1, username: "bob", nickname: "Bob", avatar: "")
            )
        ) { CallFeature() }
    )
}

#Preview("语音通话中 — 深色") {
    CallView(
        store: Store(
            initialState: CallFeature.State(
                phase: .connected,
                callType: .voice,
                peer: CallUserDTO(id: 42, username: "alice", nickname: "Alice", avatar: ""),
                role: .caller,
                isMuted: true,
                isSpeakerOn: true,
                durationSeconds: 305,
                localUser: CallUserDTO(id: 1, username: "bob", nickname: "Bob", avatar: "")
            )
        ) { CallFeature() }
    )
    .preferredColorScheme(.dark)
}
