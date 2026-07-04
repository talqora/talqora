import Dependencies
import DependenciesMacros
import Foundation

// 通讯录数据源。liveValue 接真实后端 GET /user/getFriendList/:id;previewValue 用样本(SwiftUI 预览离线渲染)。
@DependencyClient
struct ContactsClient: Sendable {
    var contacts: @Sendable () async throws -> [Contact]
    // 更新好友备注:PUT /user/updateRemark;remark 传 nil/空即清空。
    var updateRemark: @Sendable (_ friendId: Int, _ remark: String?) async throws -> Void
}

extension ContactsClient: DependencyKey {
    static let liveValue = ContactsClient(
        contacts: {
            @Dependency(\.apiClient) var apiClient // 带 Bearer 的鉴权客户端
            @Dependency(\.sessionClient) var session
            guard let userId = session.currentUserId() else { throw AuthError.notAuthenticated }
            let data = try await apiClient.sendUnwrapping(
                APIRequest.get("/user/getFriendList/\(userId)"),
                as: APIFriendList.self
            )
            // data 为两张 id 映射:friendId(id→备注,可空)、friendInfo(id→资料)。
            return toContacts(remarks: data.friendId.additionalProperties, infos: data.friendInfo.additionalProperties)
        },
        updateRemark: { friendId, remark in
            @Dependency(\.apiClient) var apiClient
            @Dependency(\.sessionClient) var session
            guard let userId = session.currentUserId() else { throw AuthError.notAuthenticated }
            struct UpdateAck: Decodable {}
            let request = try APIRequest.put("/user/updateRemark", json: [
                "userId": String(userId),
                "friendId": String(friendId),
                "remark": remark ?? "", // 空串 → 服务端清空备注
            ])
            _ = try await apiClient.send(request, decoding: UpdateAck.self)
        }
    )

    static let previewValue = ContactsClient(
        contacts: { ContactSamples.all },
        updateRemark: { _, _ in }
    )
}

extension DependencyValues {
    var contactsClient: ContactsClient {
        get { self[ContactsClient.self] }
        set { self[ContactsClient.self] = newValue }
    }
}

// remarks: id→备注(可空);infos: id→资料。备注优先于昵称作展示名。
private func toContacts(remarks: [String: String?], infos: [String: APIFriendInfo]) -> [Contact] {
    infos.map { id, info in
        let rawRemark = remarks[id] ?? nil // 外层 optional 是 dict 命中,内层是"备注可空"
        let remark = (rawRemark?.isEmpty ?? true) ? nil : rawRemark
        let name = remark ?? info.username
        return Contact(
            id: id,
            name: name,
            username: info.username,
            remark: remark,
            avatarURL: info.avatar.flatMap(URL.init(string:)),
            sectionKey: ContactSectioning.key(for: name)
        )
    }
    .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
}

// 拼音首字母分组:用 iOS 自带 CFStringTransform 把中文转拉丁(拼音)取首字母;非字母归 "#"。
enum ContactSectioning {
    static func key(for name: String) -> String {
        let mutable = NSMutableString(string: name) as CFMutableString
        CFStringTransform(mutable, nil, kCFStringTransformToLatin, false)
        CFStringTransform(mutable, nil, kCFStringTransformStripDiacritics, false)
        guard let first = (mutable as String).first, first.isLetter else { return "#" }
        return first.uppercased()
    }
}

// SwiftUI 预览用样本(离线零网络)。
enum ContactSamples {
    static let all: [Contact] = [
        Contact(id: "a1", name: "AA移动陈志娟18870410788", sectionKey: "A"),
        Contact(id: "a2", name: "艾芳", sectionKey: "A"),
        Contact(id: "a3", name: "aik9", sectionKey: "A"),
        Contact(id: "b1", name: "白桦", sectionKey: "B"),
        Contact(id: "c1", name: "陈睿", sectionKey: "C"),
        Contact(id: "d1", name: "段宇皓", sectionKey: "D"),
        Contact(id: "f1", name: "冯是杰", sectionKey: "F"),
        Contact(id: "l1", name: "李雷", sectionKey: "L"),
        Contact(id: "w1", name: "王博扬", sectionKey: "W"),
        Contact(id: "z1", name: "张伟", sectionKey: "Z"),
        Contact(id: "h1", name: "123hao", sectionKey: "#"),
    ]
}
