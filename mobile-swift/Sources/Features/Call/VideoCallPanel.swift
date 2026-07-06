import ComposableArchitecture
import Services
import DesignSystem
import SwiftUI
import WebRTC

// 视频通话 panel:远端视频全屏 + 本地自视图(PiP 右上角) + 姓名/状态叠加 + 控制条底部。
struct VideoCallPanel: View {
    @Bindable var store: StoreOf<CallFeature>
    @Dependency(\.webRTCSession) private var webRTC

    // 从盒子取出的 RTCVideoTrack 只在 MainActor(本 State)上被持有并交给渲染器,满足盒子的不变量。
    @State private var remoteTrack: RTCVideoTrack?
    @State private var localTrack: RTCVideoTrack?

    var body: some View {
        ZStack(alignment: .bottom) {
            // 远端视频全屏背景;track=nil(未到帧 / 模拟器)时黑底占位不崩。
            RTCVideoView(track: remoteTrack)
                .ignoresSafeArea()
                .background(WeChatColor.videoSurface)

            // 顶部:对端昵称 + 通话状态
            VideoCallStatusOverlay(store: store)

            // 右上角:本地 PiP
            LocalPiPView(track: localTrack)

            // 底部控制条
            VStack {
                Spacer()
                CallControlBar(store: store)
            }
        }
        .ignoresSafeArea()
        .task {
            localTrack = await webRTC.localVideoTrack()?.track
        }
        .task(id: store.hasRemoteVideo) {
            guard store.hasRemoteVideo else { return }
            remoteTrack = await webRTC.remoteVideoTrack()?.track
        }
    }
}

// MARK: - Previews

#Preview("视频振铃") {
    VideoCallPanel(
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
    VideoCallPanel(
        store: Store(
            initialState: CallFeature.State(
                phase: .connected,
                callType: .video,
                peer: CallUserDTO(id: 42, username: "alice", nickname: "Alice", avatar: ""),
                role: .caller,
                isCameraOn: true,
                hasRemoteVideo: true,
                durationSeconds: 210,
                localUser: CallUserDTO(id: 1, username: "bob", nickname: "Bob", avatar: "")
            )
        ) { CallFeature() }
    )
    .preferredColorScheme(.dark)
}
