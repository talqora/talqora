import Dependencies
import DependenciesMacros
import Foundation

public enum WebRTCEvent: Equatable, Sendable {
    case localCandidate(IceCandidateDTO)
    case remoteVideoAvailable
    case connectionState(String)   // "connected"|"failed"|"closed"|...
}

@DependencyClient
public struct WebRTCSession: Sendable {
    public var configure: @Sendable (_ iceServers: [IceServerDTO], _ relayOnly: Bool) async -> Void
    public var startLocalMedia: @Sendable (_ video: Bool) async throws -> Void
    public var createOffer: @Sendable () async throws -> SessionDescriptionDTO
    public var createAnswer: @Sendable (_ remoteOffer: SessionDescriptionDTO) async throws -> SessionDescriptionDTO
    public var setRemoteAnswer: @Sendable (_ answer: SessionDescriptionDTO) async throws -> Void
    public var addRemoteCandidate: @Sendable (_ c: IceCandidateDTO) async -> Void
    public var setMuted: @Sendable (_ muted: Bool) async -> Void
    public var setCameraEnabled: @Sendable (_ on: Bool) async -> Void
    public var switchCamera: @Sendable () async -> Void
    public var setSpeaker: @Sendable (_ on: Bool) async -> Void
    public var reset: @Sendable () async -> Void
    public var close: @Sendable () async -> Void
    public var events: @Sendable () -> AsyncStream<WebRTCEvent> = { .finished }
    public var localVideoTrack: @Sendable () async -> VideoTrackBox? = { nil }
    public var remoteVideoTrack: @Sendable () async -> VideoTrackBox? = { nil }
}

extension WebRTCSession: DependencyKey {
    public static let previewValue = WebRTCSession(
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
        events: { .finished },
        localVideoTrack: { nil },
        remoteVideoTrack: { nil }
    )

    public static var liveValue: WebRTCSession {
        let engine = RTCEngine()
        return WebRTCSession(
            configure: { await engine.configure($0, relayOnly: $1) },
            startLocalMedia: { try await engine.startLocalMedia(video: $0) },
            createOffer: { try await engine.createOffer() },
            createAnswer: { try await engine.createAnswer(remoteOffer: $0) },
            setRemoteAnswer: { try await engine.setRemoteAnswer($0) },
            addRemoteCandidate: { await engine.addRemoteCandidate($0) },
            setMuted: { await engine.setMuted($0) },
            setCameraEnabled: { await engine.setCameraEnabled($0) },
            switchCamera: { await engine.switchCamera() },
            setSpeaker: { await engine.setSpeaker($0) },
            reset: { await engine.reset() },
            close: { await engine.close() },
            events: {
                let (stream, cont) = AsyncStream<WebRTCEvent>.makeStream()
                Task { await engine.addSubscriber(cont) }
                return stream
            },
            localVideoTrack: { await engine.localVideoTrackBox() },
            remoteVideoTrack: { await engine.remoteVideoTrackBox() }
        )
    }
}

extension DependencyValues {
    public var webRTCSession: WebRTCSession {
        get { self[WebRTCSession.self] }
        set { self[WebRTCSession.self] = newValue }
    }
}
