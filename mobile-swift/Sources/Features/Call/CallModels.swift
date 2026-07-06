import Foundation
import Models

// CallType 已下沉到 Models(Services 的 socket 解析也要用)。此处保留通话页内部状态类型。
public enum CallRole: Equatable, Sendable { case caller, callee }

public enum CallPhase: Equatable, Sendable {
    case idle
    case outgoing         // 主叫已发 call:start,等 accept
    case incoming         // 被叫振铃
    case connecting       // 已 accept,ICE 协商中
    case connected        // 媒体已通
    case reconnecting     // grace 窗内重连
    case ended(reason: String)
}
