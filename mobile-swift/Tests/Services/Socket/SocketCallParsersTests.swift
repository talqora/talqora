import Testing
@testable import OurChat

struct SocketCallParsersTests {
    @Test func parsesIncomingCallStart() {
        let raw: [String: Any] = [
            "callId": "call_1_2_1700000000",
            "from": ["id": 1, "username": "a", "nickname": "A", "avatar": ""],
            "to": ["id": 2, "username": "b", "nickname": "B", "avatar": ""],
            "offer": ["type": "offer", "sdp": "v=0"],
            "callType": "video",
        ]
        let ev = SocketCallParsers.parseIncoming(raw)
        #expect(ev?.callId == "call_1_2_1700000000")
        #expect(ev?.from.id == 1)
        #expect(ev?.callType == .video)
    }

    @Test func parsesAcceptWithIntFromTo() {
        let raw: [String: Any] = [
            "callId": "c1", "from": 2, "to": 1,
            "answer": ["type": "answer", "sdp": "v=0"],
        ]
        let ev = SocketCallParsers.parseAccept(raw)
        #expect(ev?.callId == "c1")
        #expect(ev?.answer.type == "answer")
    }

    @Test func parsesNestedIceCandidate() {
        let raw: [String: Any] = [
            "callId": "c1",
            "candidate": ["candidate": "candidate:1 ...", "sdpMlineIndex": 0, "sdpMid": "0"],
        ]
        let ev = SocketCallParsers.parseIce(raw)
        #expect(ev?.candidate.sdpMlineIndex == 0)
    }

    @Test func rejectsMalformed() {
        #expect(SocketCallParsers.parseIce(["callId": "c1"]) == nil)
    }
}
