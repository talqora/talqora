import Foundation

// 通话类型(语音/视频)。共享域模型:socket 解析(Services)与通话/好友页(Features)都用,故放 Models。
public enum CallType: String, Equatable, Sendable {
    case voice
    case video
}
