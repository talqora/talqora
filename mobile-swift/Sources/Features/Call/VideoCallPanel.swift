import ComposableArchitecture
import SwiftUI

// 视频通话 panel:远端视频全屏 + 本地自视图(PiP 右上角) + 姓名/状态叠加 + 控制条底部。
struct VideoCallPanel: View {
    @Bindable var store: StoreOf<CallFeature>

    var body: some View {
        ZStack(alignment: .bottom) {
            // 远端视频全屏背景(track 接线留 T12)
            RTCVideoView(track: nil)
                .ignoresSafeArea()
                .background(Color.black) // track=nil 时显示黑底

            // 顶部:对端昵称 + 通话状态
            peerStatusOverlay

            // 右上角:本地 PiP
            LocalPiPView()

            // 底部控制条
            VStack {
                Spacer()
                CallControlBar(store: store)
            }
        }
        .ignoresSafeArea()
    }

    // 对端昵称 + 状态叠加在视频顶部,带渐变保证可读性。
    private var peerStatusOverlay: some View {
        VStack {
            LinearGradient(
                colors: [Color.black.opacity(0.55), Color.clear],
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

// MARK: - 本地 PiP(画中画)

// 小矩形显示本端视频,固定在右上角安全区内侧。T12 真实接入前显示深色占位。
struct LocalPiPView: View {
    private let width: CGFloat = 90
    private let height: CGFloat = 130

    var body: some View {
        VStack {
            HStack {
                Spacer()
                RoundedRectangle(cornerRadius: WeChatRadius.l)
                    .fill(Color.black.opacity(0.7))
                    .frame(width: width, height: height)
                    .overlay(
                        Image(systemName: "person.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(Color.white.opacity(0.5))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: WeChatRadius.l)
                            .stroke(Color.white.opacity(0.3), lineWidth: 1)
                    )
                    .padding(.top, 60)   // 安全区顶部
                    .padding(.trailing, WeChatSpacing.l)
            }
            Spacer()
        }
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false) // PiP 仅展示,不消耗触摸
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
