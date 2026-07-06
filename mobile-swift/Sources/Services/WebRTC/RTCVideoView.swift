import SwiftUI
import WebRTC

public struct RTCVideoView: UIViewRepresentable {
    public let track: RTCVideoTrack?

    public init(track: RTCVideoTrack?) {
        self.track = track
    }

    public func makeUIView(context: Context) -> RTCMTLVideoView {
        let v = RTCMTLVideoView()
        v.videoContentMode = .scaleAspectFill
        return v
    }

    public func updateUIView(_ v: RTCMTLVideoView, context: Context) {
        track?.add(v)
    }
}
