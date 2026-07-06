import Foundation

// 通讯录联系人。sectionKey 为拼音/字母首字母(A-Z),非字母归 "#"。
// name 为展示名(有备注用备注,否则昵称);username/remark 分开存,便于备注编辑后本地重算展示名。
public struct Contact: Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String
    public var username: String
    public var remark: String?
    public var avatarURL: URL?
    public var sectionKey: String

    public init(
        id: String,
        name: String,
        username: String = "",
        remark: String? = nil,
        avatarURL: URL? = nil,
        sectionKey: String
    ) {
        self.id = id
        self.name = name
        self.username = username
        self.remark = remark
        self.avatarURL = avatarURL
        self.sectionKey = sectionKey
    }
}

extension Array where Element == Contact {
    // 按 sectionKey 分组并排序,# 永远排在最后。供索引列表渲染。
    public func groupedBySection() -> [(key: String, contacts: [Contact])] {
        let grouped = Dictionary(grouping: self, by: \.sectionKey)
        return grouped
            .map { (key: $0.key, contacts: $0.value.sorted { $0.name < $1.name }) }
            .sorted { lhs, rhs in
                if lhs.key == "#" { return false }
                if rhs.key == "#" { return true }
                return lhs.key < rhs.key
            }
    }
}
