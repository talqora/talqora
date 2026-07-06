import ComposableArchitecture
import DesignSystem
import SwiftUI

struct KnowledgeAssistantView: View {
    @Bindable var store: StoreOf<KnowledgeAssistantFeature>

    var body: some View {
        TabView(selection: $store.selectedTab) {
            Tab("对话", systemImage: "bubble.left.and.bubble.right", value: KnowledgeAssistantFeature.Tab.chat) {
                AgentChatListView(store: store.scope(state: \.chat, action: \.chat))
            }
            Tab("知识库", systemImage: "books.vertical", value: KnowledgeAssistantFeature.Tab.documents) {
                AgentDocumentsView(store: store.scope(state: \.documents, action: \.documents))
            }
            Tab("任务", systemImage: "sparkles", value: KnowledgeAssistantFeature.Tab.tasks) {
                AgentTasksView(store: store.scope(state: \.tasks, action: \.tasks))
            }
        }
        .tint(WeChatColor.brand)
    }
}

#Preview {
    KnowledgeAssistantView(
        store: Store(initialState: KnowledgeAssistantFeature.State()) {
            KnowledgeAssistantFeature()
        }
    )
}

#Preview("深色") {
    KnowledgeAssistantView(
        store: Store(initialState: KnowledgeAssistantFeature.State()) {
            KnowledgeAssistantFeature()
        }
    )
    .preferredColorScheme(.dark)
}
