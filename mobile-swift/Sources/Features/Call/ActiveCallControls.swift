import ComposableArchitecture
import SwiftUI

// 通话中控制区:功能切换按钮 + 挂断
struct ActiveCallControls: View {
    @Bindable var store: StoreOf<CallFeature>
    let onHaptic: () -> Void

    var body: some View {
        VStack(spacing: WeChatSpacing.xl) {
            HStack(spacing: 32) {
                CallToggleButton(
                    systemName: store.isMuted ? "mic.slash.fill" : "mic.fill",
                    label: store.isMuted ? "已静音" : "静音",
                    isActive: store.isMuted
                ) {
                    store.send(.toggleMute)
                }

                CallToggleButton(
                    systemName: store.isSpeakerOn ? "speaker.wave.3.fill" : "speaker.fill",
                    label: "扬声器",
                    isActive: store.isSpeakerOn
                ) {
                    store.send(.toggleSpeaker)
                }

                if store.callType == .video {
                    CallToggleButton(
                        systemName: store.isCameraOn ? "video.fill" : "video.slash.fill",
                        label: store.isCameraOn ? "摄像头" : "已关闭",
                        isActive: !store.isCameraOn
                    ) {
                        store.send(.toggleCamera)
                    }

                    CallToggleButton(
                        systemName: "camera.rotate.fill",
                        label: "翻转",
                        isActive: false
                    ) {
                        store.send(.switchCamera)
                    }
                }
            }

            // 挂断按钮居中
            CallCircleButton(
                systemName: "phone.down.fill",
                label: "挂断",
                tint: WeChatColor.badge,
                isActive: false
            ) {
                onHaptic()
                store.send(.hangupTapped)
            }
        }
    }
}
