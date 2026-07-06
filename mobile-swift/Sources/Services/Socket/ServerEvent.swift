import Foundation
import Models

// 服务端实时事件的统一表示。SocketClient 把每一种 socket.on 事件解析成一个 case,
// 经单一 events() 流扇出给各订阅方(聊天详情 / 通讯录 …)。
// 新增服务端事件(如后续 call:* / presence / read)在此扩展一个 case 即可,收发口径不散落。
public enum ServerEvent: Equatable, Sendable {
    case message(ChatMessage)          // receiveMessage
    case friendRequest(FriendRequest)  // receiveFriendReq(对方发来、待我验证)
    case friendListChanged             // friendListChanged(好友关系变更,需刷新)

    case callIncoming(CallIncoming)                                              // call:start
    case callAccepted(callId: String, answer: SessionDescriptionDTO)             // call:accept
    case callRejected(callId: String)                                            // call:reject
    case callEnded(callId: String)                                               // call:end
    case callIce(callId: String, candidate: IceCandidateDTO)                    // call:ice
    case callRejoin(CallRejoin)                                                  // call:rejoin
    case callBusy(callId: String)                                                // call:busy
    case callHandled(callId: String, status: String)                             // call:handled
    case callPeerReconnecting(callId: String)                                    // call:peer-reconnecting
}

public struct CallIncoming: Equatable, Sendable {
    public var callId: String
    public var from: CallUserDTO
    public var to: CallUserDTO
    public var offer: SessionDescriptionDTO
    public var callType: CallType

    public init(callId: String, from: CallUserDTO, to: CallUserDTO, offer: SessionDescriptionDTO, callType: CallType) {
        self.callId = callId; self.from = from; self.to = to; self.offer = offer; self.callType = callType
    }
}

public struct CallRejoin: Equatable, Sendable {
    public var callId: String
    public var from: CallUserDTO
    public var to: CallUserDTO
    public var offer: SessionDescriptionDTO

    public init(callId: String, from: CallUserDTO, to: CallUserDTO, offer: SessionDescriptionDTO) {
        self.callId = callId; self.from = from; self.to = to; self.offer = offer
    }
}
