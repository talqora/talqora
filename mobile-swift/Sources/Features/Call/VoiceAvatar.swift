import SwiftUI

// 圆形头像:语音通话专用,无网络图时显示 person 图标占位。
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
            .overlay {
                Image(systemName: "person.fill")
                    // 图标大小随 size 等比缩放,不用固定令牌
                    .font(.system(size: size * 0.5))
                    .foregroundStyle(WeChatColor.textTertiary)
            }
    }
}
