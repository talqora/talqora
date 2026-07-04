import ComposableArchitecture
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
            colors: [Color(hex: 0x1A2035), Color(hex: 0x0D1220)],
            startPoint: .top,
            endPoint: .bottom
        )
        .ignoresSafeArea()
    }

    private var peerInfo: some View {
        VStack(spacing: WeChatSpacing.l) {
            // 圆形头像(语音通话使用圆形)
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

// MARK: - 圆形头像(语音通话专用,占位显示 person 图标)

struct VoiceAvatar: View {
    let url: URL?
    let size: CGFloat

    var body: some View {
        Group {
            if let url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        avatarPlaceholder
                    }
                }
            } else {
                avatarPlaceholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private var avatarPlaceholder: some View {
        Circle()
            .fill(WeChatColor.avatarPlaceholder)
            .overlay(
                Image(systemName: "person.fill")
                    .font(.system(size: size * 0.5))
                    .foregroundStyle(WeChatColor.textTertiary)
            )
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
