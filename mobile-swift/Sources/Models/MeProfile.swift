import Foundation

// 「我」页用户资料。共享域模型:MeClient(Services)产出、Me/Profile(Features)消费,故放 Models。
public struct MeProfile: Equatable, Sendable {
    public var name: String
    public var wxid: String
    public var avatarURL: URL?
    public var friendCount: Int

    public init(name: String, wxid: String, avatarURL: URL?, friendCount: Int) {
        self.name = name
        self.wxid = wxid
        self.avatarURL = avatarURL
        self.friendCount = friendCount
    }
}

extension MeProfile {
    public static let empty = MeProfile(name: "", wxid: "", avatarURL: nil, friendCount: 0)

    public static let sample = MeProfile(
        name: "段宇皓",
        wxid: "1024",
        avatarURL: nil,
        friendCount: 6
    )
}
