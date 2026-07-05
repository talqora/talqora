import ComposableArchitecture
import SwiftUI

struct KnowledgeAssistantView: View {
    @Bindable var store: StoreOf<KnowledgeAssistantFeature>

    var body: some View {
        TabView(selection: $store.selectedTab) {
            Tab("对话", systemImage: "bubble.left.and.bubble.right", value: KnowledgeAssistantFeature.Tab.chat) {
                placeholderView(title: "对话", systemImage: "bubble.left.and.bubble.right")
            }
            Tab("知识库", systemImage: "books.vertical", value: KnowledgeAssistantFeature.Tab.documents) {
                placeholderView(title: "知识库", systemImage: "books.vertical")
            }
            Tab("任务", systemImage: "sparkles", value: KnowledgeAssistantFeature.Tab.tasks) {
                placeholderView(title: "任务", systemImage: "sparkles")
            }
        }
        .tint(WeChatColor.brand)
    }

    @ViewBuilder
    private func placeholderView(title: String, systemImage: String) -> some View {
        ZStack {
            WeChatColor.background.ignoresSafeArea()
            ContentUnavailableView {
                Label(title, systemImage: systemImage)
                    .font(WeChatFont.navTitle)
                    .foregroundStyle(WeChatColor.textSecondary)
            } description: {
                Text("即将上线")
                    .font(WeChatFont.subheadline)
                    .foregroundStyle(WeChatColor.textTertiary)
            }
        }
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
