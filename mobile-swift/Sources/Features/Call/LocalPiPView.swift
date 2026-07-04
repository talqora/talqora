import SwiftUI
import WebRTC

// 本地 PiP(画中画):小矩形显示本端视频,固定在右上角安全区内侧。
// 有本地视频轨时渲染实时自视图,否则回落到深色人像占位(如模拟器无摄像头 / 摄像头关闭)。
struct LocalPiPView: View {
    let track: RTCVideoTrack?
    private let width: CGFloat = 90
    private let height: CGFloat = 130

    var body: some View {
        VStack {
            HStack {
                Spacer()
                RoundedRectangle(cornerRadius: WeChatRadius.l)
                    .fill(WeChatColor.pipFill)
                    .frame(width: width, height: height)
                    .overlay {
                        if let track {
                            RTCVideoView(track: track)
                                .clipShape(RoundedRectangle(cornerRadius: WeChatRadius.l))
                        } else {
                            Image(systemName: "person.fill")
                                .font(WeChatFont.callIconPiP)
                                .foregroundStyle(Color.white.opacity(0.5))
                        }
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: WeChatRadius.l)
                            .stroke(WeChatColor.pipStroke, lineWidth: 1)
                    }
                    .padding(.top, 60)   // 安全区顶部
                    .padding(.trailing, WeChatSpacing.l)
            }
            Spacer()
        }
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false) // PiP 仅展示,不消耗触摸
    }
}
