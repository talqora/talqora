import ComposableArchitecture
import SwiftUI

struct MiniAppView: View {
    @Bindable var store: StoreOf<MiniAppFeature>
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        // 公共容器提供顶部 chrome(标题 + 关闭),本体在其下方布局,二者解耦不重合。
        MiniAppContainer(title: "知识库助手", onClose: { dismiss() }) {
            if store.authorized {
                KnowledgeAssistantView(store: store.scope(state: \.assistant, action: \.assistant))
            } else {
                AgentAuthView(store: store.scope(state: \.auth, action: \.auth))
            }
        }
        .onAppear { store.send(.onAppear) }
    }
}

#Preview("未授权") {
    MiniAppView(
        store: Store(initialState: MiniAppFeature.State(authorized: false)) {
            MiniAppFeature()
        } withDependencies: {
            $0.agentAuth = .previewValue
            $0.agentAuth.isAuthorized = { false }
        }
    )
}

#Preview("已授权") {
    MiniAppView(
        store: Store(initialState: MiniAppFeature.State(authorized: true)) {
            MiniAppFeature()
        } withDependencies: {
            $0.agentAuth = .previewValue
        }
    )
}

#Preview("深色 - 未授权") {
    MiniAppView(
        store: Store(initialState: MiniAppFeature.State(authorized: false)) {
            MiniAppFeature()
        } withDependencies: {
            $0.agentAuth = .previewValue
            $0.agentAuth.isAuthorized = { false }
        }
    )
    .preferredColorScheme(.dark)
}
