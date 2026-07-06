import ComposableArchitecture
import Services
import DesignSystem
import SwiftUI

struct AgentAuthView: View {
    @Bindable var store: StoreOf<AgentAuthFeature>

    var body: some View {
        ZStack {
            WeChatColor.background.ignoresSafeArea()

            VStack(spacing: WeChatSpacing.xl) {
                Spacer()

                // 图标
                ZStack {
                    Circle()
                        .fill(WeChatColor.brand.opacity(0.12))
                        .frame(width: 96, height: 96)
                    Image(systemName: "sparkles")
                        .font(.system(size: 44, weight: .medium))
                        .foregroundStyle(WeChatColor.brand)
                        .symbolEffect(.pulse)
                }
                .accessibilityHidden(true)

                // 标题 + 说明
                VStack(spacing: WeChatSpacing.m) {
                    Text("知识库助手")
                        .font(WeChatFont.title)
                        .foregroundStyle(WeChatColor.textPrimary)

                    Text("接入智能知识库服务，需一键授权后使用")
                        .font(WeChatFont.subheadline)
                        .foregroundStyle(WeChatColor.textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, WeChatSpacing.xl)
                }

                // 错误提示
                if let msg = store.errorMessage {
                    HStack(spacing: WeChatSpacing.xs) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(WeChatFont.footnote)
                        Text(msg)
                            .font(WeChatFont.footnote)
                    }
                    .foregroundStyle(WeChatColor.badge)
                    .padding(.horizontal, WeChatSpacing.xl)
                    .accessibilityLabel("错误：\(msg)")
                }

                // 授权按钮
                Button {
                    store.send(.authorizeTapped)
                } label: {
                    ZStack {
                        if store.isLoading {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text(store.errorMessage != nil ? "重试" : "一键授权")
                                .font(WeChatFont.body)
                                .fontWeight(.semibold)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(store.isLoading ? WeChatColor.brand.opacity(0.6) : WeChatColor.brand)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: WeChatRadius.l))
                }
                .buttonStyle(PressableButtonStyle())
                .disabled(store.isLoading)
                .padding(.horizontal, WeChatSpacing.xl)
                .accessibilityLabel(store.isLoading ? "授权中，请稍候" : (store.errorMessage != nil ? "重试授权" : "一键授权"))
                .accessibilityHint("点击后授权访问知识库助手")

                Spacer()
                Spacer()
            }
        }
    }
}

// MARK: - Previews

#Preview("空闲态") {
    AgentAuthView(
        store: Store(initialState: AgentAuthFeature.State()) {
            AgentAuthFeature()
        } withDependencies: {
            $0.agentAuth = .previewValue
        }
    )
}

#Preview("加载中") {
    AgentAuthView(
        store: Store(initialState: AgentAuthFeature.State(isLoading: true)) {
            AgentAuthFeature()
        } withDependencies: {
            $0.agentAuth = .previewValue
        }
    )
}

#Preview("错误态") {
    AgentAuthView(
        store: Store(initialState: AgentAuthFeature.State(errorMessage: "授权失败，请重试")) {
            AgentAuthFeature()
        } withDependencies: {
            $0.agentAuth = .previewValue
        }
    )
}

#Preview("深色 - 空闲态") {
    AgentAuthView(
        store: Store(initialState: AgentAuthFeature.State()) {
            AgentAuthFeature()
        } withDependencies: {
            $0.agentAuth = .previewValue
        }
    )
    .preferredColorScheme(.dark)
}
