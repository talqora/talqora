import Foundation
import Models

// 把 socket.io 投递的 call:* 原始字典解析成领域类型。纯函数,可单测。
public enum SocketCallParsers {
    static func parseUser(_ any: Any?) -> CallUserDTO? {
        guard let d = any as? [String: Any], let id = SocketMessageParser.intValue(d["id"]) else { return nil }
        return CallUserDTO(id: id,
                           username: d["username"] as? String ?? "",
                           nickname: d["nickname"] as? String ?? "",
                           avatar: d["avatar"] as? String ?? "")
    }
    static func parseSDP(_ any: Any?) -> SessionDescriptionDTO? {
        guard let d = any as? [String: Any], let type = d["type"] as? String, let sdp = d["sdp"] as? String
        else { return nil }
        return SessionDescriptionDTO(type: type, sdp: sdp)
    }
    static func parseCandidate(_ any: Any?) -> IceCandidateDTO? {
        guard let d = any as? [String: Any], let c = d["candidate"] as? String else { return nil }
        return IceCandidateDTO(candidate: c,
                               sdpMlineIndex: SocketMessageParser.intValue(d["sdpMlineIndex"]),
                               sdpMid: d["sdpMid"] as? String)
    }
    static func parseIncoming(_ raw: Any) -> CallIncoming? {
        guard let d = raw as? [String: Any], let callId = d["callId"] as? String,
              let from = parseUser(d["from"]), let to = parseUser(d["to"]),
              let offer = parseSDP(d["offer"]) else { return nil }
        let type = CallType(rawValue: d["callType"] as? String ?? "voice") ?? .voice
        return CallIncoming(callId: callId, from: from, to: to, offer: offer, callType: type)
    }
    static func parseAccept(_ raw: Any) -> (callId: String, answer: SessionDescriptionDTO)? {
        guard let d = raw as? [String: Any], let callId = d["callId"] as? String,
              let answer = parseSDP(d["answer"]) else { return nil }
        return (callId, answer)
    }
    static func parseIce(_ raw: Any) -> (callId: String, candidate: IceCandidateDTO)? {
        guard let d = raw as? [String: Any], let callId = d["callId"] as? String,
              let cand = parseCandidate(d["candidate"]) else { return nil }
        return (callId, cand)
    }
    static func parseRejoin(_ raw: Any) -> CallRejoin? {
        guard let d = raw as? [String: Any], let callId = d["callId"] as? String,
              let from = parseUser(d["from"]), let to = parseUser(d["to"]),
              let offer = parseSDP(d["offer"]) else { return nil }
        return CallRejoin(callId: callId, from: from, to: to, offer: offer)
    }
    static func callId(_ raw: Any) -> String? { (raw as? [String: Any])?["callId"] as? String }
    static func handledStatus(_ raw: Any) -> String? { (raw as? [String: Any])?["status"] as? String }
}
