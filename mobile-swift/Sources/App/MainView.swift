import ComposableArchitecture
import ContactBook
import Chats
import MiniApp
import Call
import Me
import Discover
import DesignSystem
import SwiftUI
import UIKit

struct MainView: View {
    @Bindable var store: StoreOf<MainFeature>

    init(store: StoreOf<MainFeature>) {
        self.store = store
        Self.configureTabBarAppearance()
    }

    var body: some View {
        TabView(selection: $store.selectedTab) {
            ChatsView(store: store.scope(state: \.chats, action: \.chats))
                .tag(MainFeature.Tab.chats)
                .tabItem { Label("微信", systemImage: "message.fill") }

            ContactsView(store: store.scope(state: \.contacts, action: \.contacts))
                .tag(MainFeature.Tab.contacts)
                .tabItem { Label("通讯录", systemImage: "person.2.fill") }

            DiscoverView()
                .tag(MainFeature.Tab.discover)
                .tabItem { Label("发现", systemImage: "safari.fill") }

            MeView(store: store.scope(state: \.me, action: \.me))
                .tag(MainFeature.Tab.me)
                .tabItem { Label("我", systemImage: "person.fill") }
        }
        .tint(WeChatColor.brand)
        .task { store.send(.onAppear) }
        .fullScreenCover(item: $store.scope(state: \.call, action: \.call)) { callStore in
            CallView(store: callStore)
        }
        .fullScreenCover(item: $store.scope(state: \.miniApp, action: \.miniApp)) { miniAppStore in
            MiniAppView(store: miniAppStore)
        }
    }

    // 暗色标签栏:不透明深色底 + 未选灰、选中微信绿。用 UITabBarAppearance 全局配置。
    private static func configureTabBarAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(WeChatColor.navBar)

        let normal = UIColor(WeChatColor.textSecondary)
        let selected = UIColor(WeChatColor.brand)
        for layout in [appearance.stackedLayoutAppearance, appearance.inlineLayoutAppearance, appearance.compactInlineLayoutAppearance] {
            layout.normal.iconColor = normal
            layout.normal.titleTextAttributes = [.foregroundColor: normal]
            layout.selected.iconColor = selected
            layout.selected.titleTextAttributes = [.foregroundColor: selected]
        }
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }
}

#Preview {
    MainView(
        store: Store(initialState: MainFeature.State()) {
            MainFeature()
        }
    )
}
