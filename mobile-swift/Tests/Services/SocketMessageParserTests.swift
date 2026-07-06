import Foundation
@testable import Services
import Testing
@testable import OurChat

struct SocketMessageParserTests {
    @Test
    func parsesReceiveMessagePayload() {
        let raw: [String: Any] = [
            "id": NSNumber(value: 42),
            "conversationId": "single_1_2",
            "senderId": NSNumber(value: 2),
            "seq": NSNumber(value: 5),
            "content": "hi",
            "type": "text",
            "clientMsgId": "c1",
            "timestamp": "2026-06-25T10:00:00.000Z",
        ]
        let message = SocketMessageParser.parse(raw)
        #expect(message?.serverId == 42)
        #expect(message?.conversationId == "single_1_2")
        #expect(message?.senderId == 2)
        #expect(message?.seq == 5)
        #expect(message?.content == "hi")
        #expect(message?.clientMsgId == "c1")
        #expect(message?.timestamp != nil)
    }

    @Test
    func parsesFileMessageWithFileInfo() {
        let raw: [String: Any] = [
            "id": 9,
            "conversationId": "single_1_2",
            "senderId": 2,
            "type": "file",
            "content": "[文件]",
            "fileInfo": [
                "fileName": "report.pdf",
                "fileSize": NSNumber(value: 2048),
                "fileUrl": "https://cdn/x/report.pdf",
            ],
        ]
        let message = SocketMessageParser.parse(raw)
        #expect(message?.type == "file")
        #expect(message?.fileInfo?.fileName == "report.pdf")
        #expect(message?.fileInfo?.fileSize == 2048)
        #expect(message?.fileInfo?.fileUrl == "https://cdn/x/report.pdf")
    }

    @Test
    func returnsNilWhenConversationIdMissing() {
        #expect(SocketMessageParser.parse(["id": 1] as [String: Any]) == nil)
    }

    @Test
    func returnsNilWhenIdMissing() {
        #expect(SocketMessageParser.parse(["conversationId": "x"] as [String: Any]) == nil)
    }

    @Test
    func intValueHandlesNumberStringAndNil() {
        #expect(SocketMessageParser.intValue(NSNumber(value: 9)) == 9)
        #expect(SocketMessageParser.intValue(7) == 7)
        #expect(SocketMessageParser.intValue("13") == 13)
        #expect(SocketMessageParser.intValue("x") == nil)
        #expect(SocketMessageParser.intValue(nil) == nil)
    }
}
