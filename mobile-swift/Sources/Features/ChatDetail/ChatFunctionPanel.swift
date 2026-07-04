import ComposableArchitecture
import SwiftUI

// 聊天页「+」功能面板:占据键盘位置的功能网格(微信约定)。
// 4 列布局便于后续扩展(拍照/位置等);当前仅「视频通话」一个磁贴,群聊会话隐藏。
struct ChatFunctionPanel: View {
    @Bindable var store: StoreOf<ChatDetailFeature>

    private let columns = Array(repeating: GridItem(.flexible(), spacing: WeChatSpacing.m), count: 4)

    var body: some View {
        LazyVGrid(columns: columns, spacing: WeChatSpacing.l) {
            if !store.isGroupConversation {
                ChatFunctionTile(systemImage: "video", title: "视频通话") {
                    store.send(.videoCallTileTapped)
                }
            }
        }
        .padding(.horizontal, WeChatSpacing.l)
        .padding(.vertical, WeChatSpacing.l)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WeChatColor.navBar)
    }
}
