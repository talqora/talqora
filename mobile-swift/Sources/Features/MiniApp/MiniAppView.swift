import ComposableArchitecture
import SwiftUI

struct MiniAppView: View {
    @Bindable var store: StoreOf<MiniAppFeature>
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if store.authorized {
                KnowledgeAssistantView(store: store.scope(state: \.assistant, action: \.assistant))
            } else {
                AgentAuthView(store: store.scope(state: \.auth, action: \.auth))
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(WeChatFont.body)
                    .foregroundStyle(WeChatColor.textSecondary)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel("关闭")
            .padding(.trailing, WeChatSpacing.s)
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
