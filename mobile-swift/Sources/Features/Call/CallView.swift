import ComposableArchitecture
import SwiftUI

// 通话全屏壳:根据 callType 分发到语音/视频 panel,共享底部控制条。
struct CallView: View {
    @Bindable var store: StoreOf<CallFeature>

    var body: some View {
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

// MARK: - 共享控制条

// 控制条按阶段切换:incoming 时显示 接受+拒绝,其余显示各功能按钮+挂断。
struct CallControlBar: View {
    @Bindable var store: StoreOf<CallFeature>

    // 用来触发触觉反馈的累计值,每次 accept/hangup 触发时 +1。
    @State private var hapticTrigger = 0

    var body: some View {
        VStack(spacing: 0) {
            if store.phase == .incoming {
                incomingControls
            } else {
                activeControls
            }
        }
        .padding(.horizontal, WeChatSpacing.xl)
        .padding(.bottom, WeChatSpacing.xl)
        .sensoryFeedback(.impact, trigger: hapticTrigger)
    }

    // 被叫振铃:接受(绿) + 拒绝(红)
    private var incomingControls: some View {
        HStack(spacing: 48) {
            Spacer()
            CallCircleButton(
                systemName: "phone.down.fill",
                label: "拒绝",
                tint: WeChatColor.badge,
                isActive: false
            ) {
                hapticTrigger += 1
                store.send(.rejectTapped)
            }
            CallCircleButton(
                systemName: "phone.fill",
                label: "接受",
                tint: WeChatColor.brand,
                isActive: false
            ) {
                hapticTrigger += 1
                store.send(.acceptTapped)
            }
            Spacer()
        }
    }

    // 通话中:功能切换按钮 + 挂断
    private var activeControls: some View {
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
                hapticTrigger += 1
                store.send(.hangupTapped)
            }
        }
    }
}

// MARK: - 圆形大按钮(接受 / 拒绝 / 挂断)

struct CallCircleButton: View {
    let systemName: String
    let label: String
    let tint: Color
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Circle()
                    .fill(tint)
                    .frame(width: 64, height: 64)
                    .overlay(
                        Image(systemName: systemName)
                            .font(.system(size: 26, weight: .medium))
                            .foregroundStyle(.white)
                    )
                Text(label)
                    .font(WeChatFont.footnote)
                    .foregroundStyle(.white)
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(label)
    }
}

// MARK: - 方形切换按钮(静音 / 扬声器 / 摄像头 / 翻转)

struct CallToggleButton: View {
    let systemName: String
    let label: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                RoundedRectangle(cornerRadius: WeChatRadius.m)
                    .fill(isActive ? Color.white.opacity(0.9) : Color.white.opacity(0.2))
                    .frame(width: 56, height: 56)
                    .overlay(
                        Image(systemName: systemName)
                            .font(.system(size: 22, weight: .medium))
                            .foregroundStyle(isActive ? Color.black : Color.white)
                    )
                Text(label)
                    .font(WeChatFont.footnote)
                    .foregroundStyle(.white)
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityLabel(label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
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
