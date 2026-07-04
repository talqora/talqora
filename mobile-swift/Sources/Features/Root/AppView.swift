import ComposableArchitecture
import SwiftUI

struct AppView: View {
    @Bindable var store: StoreOf<RootFeature>
    // 外观设置:全 App 根部统一应用,SettingsView 写同一 key 即可一键切换。
    @AppStorage("appearanceMode") private var appearance: AppearanceMode = .system
    // 语言设置:根部设 environment locale,全 App LocalizedStringKey 随之实时切换。
    @AppStorage("appLanguage") private var language: LanguageMode = .system
    // 全 App 占位提示中心:未上线功能点点击后弹 toast。
    @State private var toast = ToastCenter()

    var body: some View {
        // ToastOverlay 与 content 同为 ZStack 子节点,确保二者都拿到注入的 toast(overlay 内容不继承同链 .environment)。
        ZStack {
            content
            ToastOverlay()
        }
        .preferredColorScheme(appearance.colorScheme)
        .environment(\.locale, language.locale ?? .autoupdatingCurrent)
        .environment(toast)
    }

    @ViewBuilder private var content: some View {
        switch store.state {
        case .loading:
            ProgressView()
                .task {
                    store.send(.onAppear)
                }

        case .login:
            if let loginStore = store.scope(state: \.login, action: \.login) {
                LoginView(store: loginStore)
            }

        case .main:
            if let mainStore = store.scope(state: \.main, action: \.main) {
                MainView(store: mainStore)
            }
        }
    }
}

#Preview {
    AppView(
        store: Store(initialState: RootFeature.State()) {
            RootFeature()
        }
    )
}
