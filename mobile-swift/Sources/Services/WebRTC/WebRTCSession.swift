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

    static var liveValue: WebRTCSession {
        let engine = RTCEngine()
        return WebRTCSession(
            configure: { await engine.configure($0, relayOnly: $1) },
            startLocalMedia: { await engine.startLocalMedia(video: $0) },
            createOffer: { try await engine.createOffer() },
            createAnswer: { try await engine.createAnswer(remoteOffer: $0) },
            setRemoteAnswer: { try await engine.setRemoteAnswer($0) },
            addRemoteCandidate: { await engine.addRemoteCandidate($0) },
            setMuted: { await engine.setMuted($0) },
            setCameraEnabled: { _ in },   // 视频采集后续任务补
            switchCamera: {},             // 视频采集后续任务补
            setSpeaker: { await engine.setSpeaker($0) },
            reset: { await engine.reset() },
            close: { await engine.close() },
            events: {
                let (stream, cont) = AsyncStream<WebRTCEvent>.makeStream()
                Task { await engine.addSubscriber(cont) }
                return stream
            }
        )
    }
}

extension DependencyValues {
    var webRTCSession: WebRTCSession {
        get { self[WebRTCSession.self] }
        set { self[WebRTCSession.self] = newValue }
    }
}
