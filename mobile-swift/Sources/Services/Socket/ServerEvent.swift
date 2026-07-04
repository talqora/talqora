import Foundation

// 服务端实时事件的统一表示。SocketClient 把每一种 socket.on 事件解析成一个 case,
// 经单一 events() 流扇出给各订阅方(聊天详情 / 通讯录 …)。
// 新增服务端事件(如后续 call:* / presence / read)在此扩展一个 case 即可,收发口径不散落。
enum ServerEvent: Equatable, Sendable {
    case message(ChatMessage)          // receiveMessage
    case friendRequest(FriendRequest)  // receiveFriendReq(对方发来、待我验证)
    case friendListChanged             // friendListChanged(好友关系变更,需刷新)
}
