import Testing
@testable import OurChat

struct SSEParserTests {
    @Test func parsesSingleEvent() {
        var p = SSEParser()
        let frames = p.consume("event: token\ndata: {\"v\":1}\n\n")
        #expect(frames.count == 1)
        #expect(frames[0].event == "token")
        #expect(frames[0].data == "{\"v\":1}")
    }
    @Test func buffersHalfFrameThenCompletes() {
        var p = SSEParser()
        #expect(p.consume("event: done\n").isEmpty)
        let frames = p.consume("data: ok\n\n")
        #expect(frames.count == 1 && frames[0].event == "done" && frames[0].data == "ok")
    }
    @Test func multipleEventsInOneChunk() {
        var p = SSEParser()
        let frames = p.consume("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n")
        #expect(frames.map(\.event) == ["a", "b"])
    }
    @Test func multiLineDataJoinedWithNewline() {
        var p = SSEParser()
        let frames = p.consume("data: line1\ndata: line2\n\n")
        #expect(frames[0].data == "line1\nline2")
    }
}
