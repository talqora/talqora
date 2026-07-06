import SwiftUI

/// 异步数据的三态容器:强制覆盖 loading / empty / error。empty 不长得像 error,error 必带重试。
public struct AsyncStateView<Item, Content: View>: View {
    public enum State {
        case loading
        case empty(String)
        case failed(String, retry: () -> Void)
        case loaded([Item])
    }

    let state: State
    @ViewBuilder let content: ([Item]) -> Content

    public init(state: State, @ViewBuilder content: @escaping ([Item]) -> Content) {
        self.state = state
        self.content = content
    }

    public var body: some View {
        switch state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .empty(message):
            ContentUnavailableView(message, systemImage: "tray")
        case let .failed(message, retry):
            ContentUnavailableView {
                Label("加载失败", systemImage: "wifi.exclamationmark")
            } description: {
                // message 是运行期错误串(即本地化 key),包成 LocalizedStringKey 走 environment locale。
                Text(LocalizedStringKey(message))
            } actions: {
                Button("重试", action: retry)
                    .buttonStyle(PressableButtonStyle())
            }
        case let .loaded(items):
            content(items)
        }
    }
}
