import Dependencies
@testable import Services
import Core
import Models
import Foundation
import Testing
@testable import OurChat

struct ChatClientTests {
    @Test
    func assemblerResolvesSingleAndGroup() {
        let friends = ["2": Contact(id: "2", name: "段宇皓", avatarURL: URL(string: "https://x/a.png"), sectionKey: "D")]
        let result = ConversationAssembler.assemble(
            userConvs: [
                .init(conversationId: "single_1_2", unreadCount: 3, isMuted: false, lastActivity: nil),
                .init(conversationId: "group_9", unreadCount: 5, isMuted: true, lastActivity: nil),
            ],
            metas: ["group_9": .init(convType: "group", title: "线代群", avatar: nil)],
            lasts: [
                "single_1_2": .init(content: "OK", type: "text", timestamp: nil),
                "group_9": .init(content: nil, type: "image", timestamp: nil),
            ],
            friends: friends,
            myUserId: 1
        )

        let single = result.first { $0.id == "single_1_2" }
        #expect(single?.title == "段宇皓") // 单聊取另一方好友名
        #expect(single?.preview == "OK")
        #expect(single?.unreadCount == 3)
        #expect(single?.isGroup == false)
        #expect(single?.avatarURL == URL(string: "https://x/a.png"))

        let group = result.first { $0.id == "group_9" }
        #expect(group?.title == "线代群")
        #expect(group?.isGroup == true)
        #expect(group?.preview == "[图片]")
        #expect(group?.unreadCount == 0) // 免打扰 → 不显示数字
        #expect(group?.hasRedDot == true) // 免打扰 + 有未读 → 红点
    }

    @Test
    func liveAggregatesThreeEndpoints() async throws {
        let userConvs = #"{"success":true,"data":[{"conversationId":"single_1_2","unreadCount":1,"isMuted":false}]}"#
        let convs = #"{"success":true,"data":{"single_1_2":{"id":"single_1_2","convType":"single"}}}"#
        let lasts = #"{"success":true,"data":{"single_1_2":{"content":"hi","type":"text"}}}"#
        try await withDependencies {
            $0.sessionClient.currentUserId = { 1 }
            $0.contactsClient.contacts = { [Contact(id: "2", name: "段宇皓", avatarURL: nil, sectionKey: "D")] }
            $0.apiClient.perform = { request in
                if request.path.contains("userConversations") { return Data(userConvs.utf8) }
                if request.path.contains("lastMessages") { return Data(lasts.utf8) }
                if request.path.contains("conversations") { return Data(convs.utf8) }
                return Data(#"{"success":true,"data":{}}"#.utf8)
            }
        } operation: {
            let result = try await ChatClient.liveValue.conversations()
            #expect(result.count == 1)
            #expect(result.first?.title == "段宇皓")
            #expect(result.first?.preview == "hi")
            #expect(result.first?.unreadCount == 1)
        }
    }

    @Test
    func messagesDecodesHistory() async throws {
        let json = #"{"success":true,"data":[{"id":1,"conversationId":"single_1_2","senderId":2,"seq":5,"content":"hi","type":"text","clientMsgId":"c1"}]}"#
        try await withDependencies {
            $0.apiClient.perform = { _ in Data(json.utf8) }
        } operation: {
            let messages = try await ChatClient.liveValue.messages("single_1_2")
            #expect(messages.count == 1)
            #expect(messages.first?.serverId == 1)
            #expect(messages.first?.senderId == 2)
            #expect(messages.first?.content == "hi")
            #expect(messages.first?.type == "text")
        }
    }

    @Test
    func messagesDecodesFullServerShape() async throws {
        // 服务端 /messages 的真实完整形状:含 extra:{}、fileInfo:{}(文本消息空对象)、
        // mentions:[]、毫秒时间戳、status/createdAt/updatedAt。验证生成类型的容器/日期解码不炸。
        let json = #"""
        {"success":true,"data":[{
          "id":5,"conversationId":"single_1_2","senderId":2,"seq":7,"clientMsgId":"c1",
          "content":"hi","type":"text","status":"sent","mentions":[],"isEdited":false,"isDeleted":false,
          "extra":{},"fileInfo":{},"editHistory":[],
          "timestamp":"2026-06-25T10:00:00.123Z","createdAt":"2026-06-25T10:00:00.000Z","updatedAt":"2026-06-25T10:00:00.000Z"
        }]}
        """#
        try await withDependencies {
            $0.apiClient.perform = { _ in Data(json.utf8) }
        } operation: {
            let messages = try await ChatClient.liveValue.messages("single_1_2")
            #expect(messages.count == 1)
            #expect(messages.first?.serverId == 5)
            #expect(messages.first?.seq == 7)
            #expect(messages.first?.fileInfo == nil) // fileInfo:{} → 无文件
            #expect(messages.first?.timestamp != nil) // 毫秒 ISO 解出 Date
        }
    }

    @Test
    func messagesDecodesFileInfo() async throws {
        let json = #"{"success":true,"data":[{"id":5,"conversationId":"single_1_2","senderId":2,"seq":1,"content":"[文件]","type":"file","fileInfo":{"fileName":"a.pdf","fileSize":4096,"fileUrl":"https://cdn/a.pdf"}}]}"#
        try await withDependencies {
            $0.apiClient.perform = { _ in Data(json.utf8) }
        } operation: {
            let messages = try await ChatClient.liveValue.messages("single_1_2")
            #expect(messages.first?.type == "file")
            #expect(messages.first?.fileInfo?.fileName == "a.pdf")
            #expect(messages.first?.fileInfo?.fileSize == 4096)
            #expect(messages.first?.fileInfo?.fileUrl == "https://cdn/a.pdf")
        }
    }
}
