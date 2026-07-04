import Foundation
import Testing
@testable import OurChat

struct CandidateBufferTests {
    private func candidate(_ id: String) -> IceCandidateDTO {
        IceCandidateDTO(candidate: "candidate:\(id)", sdpMlineIndex: 0, sdpMid: "0")
    }

    @Test func bufferedBeforeRemoteDescription() {
        var buffer = CandidateBuffer()
        let ready = buffer.add(candidate("a"), remoteDescriptionSet: false)
        #expect(ready == nil)
        #expect(buffer.pending.count == 1)
    }

    @Test func passthroughAfterRemoteDescription() {
        var buffer = CandidateBuffer()
        let ready = buffer.add(candidate("a"), remoteDescriptionSet: true)
        #expect(ready == candidate("a"))
        #expect(buffer.pending.isEmpty)
    }

    @Test func drainReturnsBufferedInOrderThenClears() {
        var buffer = CandidateBuffer()
        _ = buffer.add(candidate("a"), remoteDescriptionSet: false)
        _ = buffer.add(candidate("b"), remoteDescriptionSet: false)
        let drained = buffer.drain()
        #expect(drained == [candidate("a"), candidate("b")])
        #expect(buffer.pending.isEmpty)
    }

    @Test func drainOnEmptyBufferIsEmpty() {
        var buffer = CandidateBuffer()
        #expect(buffer.drain().isEmpty)
    }
}
