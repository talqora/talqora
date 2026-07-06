import Foundation

// 远端候选在 setRemoteDescription 之前可能先到达(信令乱序),此时 PeerConnection
// 还不能接受候选,需暂存;等 remoteDescription 就位后再一次性补投。对齐 web 端的早到候选缓冲。
public struct CandidateBuffer: Equatable, Sendable {
    private(set) var pending: [IceCandidateDTO] = []

    // remoteDescriptionSet 为 true 时直接返回该候选交给调用方投递,否则暂存并返回 nil。
    mutating func add(_ candidate: IceCandidateDTO, remoteDescriptionSet: Bool) -> IceCandidateDTO? {
        if remoteDescriptionSet {
            return candidate
        }
        pending.append(candidate)
        return nil
    }

    // 取出全部暂存候选并清空缓冲,供 remoteDescription 就位后补投。
    mutating func drain() -> [IceCandidateDTO] {
        let items = pending
        pending = []
        return items
    }
}
