import SwiftUI
import WebRTC

struct RTCVideoView: UIViewRepresentable {
    let track: RTCVideoTrack?

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let v = RTCMTLVideoView()
        v.videoContentMode = .scaleAspectFill
        return v
    }

    func updateUIView(_ v: RTCMTLVideoView, context: Context) {
        track?.add(v)
    }
}
