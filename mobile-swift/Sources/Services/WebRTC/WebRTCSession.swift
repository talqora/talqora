import Dependencies
import DependenciesMacros
import Foundation

enum WebRTCEvent: Equatable, Sendable {
    case localCandidate(IceCandidateDTO)
    case remoteVideoAvailable
    case connectionState(String)   // "connected"|"failed"|"closed"|...
}

@DependencyClient
struct WebRTCSession: Sendable {
    var configure: @Sendable (_ iceServers: [IceServerDTO], _ relayOnly: Bool) async -> Void
    var startLocalMedia: @Sendable (_ video: Bool) async throws -> Void
    var createOffer: @Sendable () async throws -> SessionDescriptionDTO
    var createAnswer: @Sendable (_ remoteOffer: SessionDescriptionDTO) async throws -> SessionDescriptionDTO
    var setRemoteAnswer: @Sendable (_ answer: SessionDescriptionDTO) async throws -> Void
    var addRemoteCandidate: @Sendable (_ c: IceCandidateDTO) async -> Void
    var setMuted: @Sendable (_ muted: Bool) async -> Void
    var setCameraEnabled: @Sendable (_ on: Bool) async -> Void
    var switchCamera: @Sendable () async -> Void
    var setSpeaker: @Sendable (_ on: Bool) async -> Void
    var reset: @Sendable () async -> Void
    var close: @Sendable () async -> Void
    var events: @Sendable () -> AsyncStream<WebRTCEvent> = { .finished }
}

extension WebRTCSession: DependencyKey {
    static let previewValue = WebRTCSession(
        configure: { _, _ in },
        startLocalMedia: { _ in },
        createOffer: { .init(type: "offer", sdp: "") },
        createAnswer: { _ in .init(type: "answer", sdp: "") },
        setRemoteAnswer: { _ in },
        addRemoteCandidate: { _ in },
        setMuted: { _ in },
        setCameraEnabled: { _ in },
        switchCamera: {},
        setSpeaker: { _ in },
        reset: {},
        close: {},
        events: { .finished }
    )

    // TODO: 临时桩，待后续任务替换为 actor-backed libwebrtc 真实实现。
    static var liveValue: WebRTCSession { previewValue }
}

extension DependencyValues {
    var webRTCSession: WebRTCSession {
        get { self[WebRTCSession.self] }
        set { self[WebRTCSession.self] = newValue }
    }
}
