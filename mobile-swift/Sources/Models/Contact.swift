import Foundation

// 通讯录联系人。sectionKey 为拼音/字母首字母(A-Z),非字母归 "#"。
// name 为展示名(有备注用备注,否则昵称);username/remark 分开存,便于备注编辑后本地重算展示名。
struct Contact: Identifiable, Equatable, Sendable {
    let id: String
    var name: String
    var username: String = ""
    var remark: String?
    var avatarURL: URL?
    var sectionKey: String
}

extension Array where Element == Contact {
    // 按 sectionKey 分组并排序,# 永远排在最后。供索引列表渲染。
    func groupedBySection() -> [(key: String, contacts: [Contact])] {
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
