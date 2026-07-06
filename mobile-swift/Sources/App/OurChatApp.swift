import ComposableArchitecture
import Services
import Core
import SwiftUI

@main
struct OurChatApp: App {
    @MainActor static let store: StoreOf<RootFeature> = {
        // 组合根:把 Core 的 tokenRefresher 抽象实装为「调 authService 刷新/登出」。
        // 这样 Core(网络层)无需依赖 Services(authService),循环被打破。
        prepareDependencies {
            $0.tokenRefresher = TokenRefresher(
                refresh: {
                    @Dependency(\.authService) var authService
                    _ = try await authService.refresh()
                },
                onRefreshFailure: {
                    @Dependency(\.authService) var authService
                    try? await authService.logout()
                }
            )
        }
        return Store(initialState: RootFeature.State()) {
            RootFeature()
        }
    }()

    var body: some Scene {
        WindowGroup {
            AppView(store: Self.store)
        }
    }
}
