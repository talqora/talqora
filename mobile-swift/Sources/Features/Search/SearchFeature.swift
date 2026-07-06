import ComposableArchitecture
import Services
import Foundation

// 搜索:输入微信号/手机号/用户名,防抖后精确查找用户。命中显示用户,未命中提示。
@Reducer
public struct SearchFeature {
    public init() {}

    @ObservableState
    public struct State: Equatable {
        public init(
            query: String = "",
            result: SearchResult? = nil,
            isSearching: Bool = false,
            notFound: Bool = false,
            requestSent: Bool = false
        ) {
            self.query = query
            self.result = result
            self.isSearching = isSearching
            self.notFound = notFound
            self.requestSent = requestSent
        }
        var query = ""
        var result: SearchResult?
        var isSearching = false
        var notFound = false
        var requestSent = false // 已对当前结果发起好友请求
    }

    public enum Action: BindableAction {
        case binding(BindingAction<State>)
        case searchResponse(SearchResult?)
        case addButtonTapped
        case addCompleted
        case closeTapped
        case delegate(Delegate)

        public enum Delegate: Equatable {
            case close
        }
    }

    @Dependency(\.searchClient) var searchClient
    @Dependency(\.friendRequestClient) var friendRequestClient
    @Dependency(\.continuousClock) var clock

    private enum CancelID { case search }

    public var body: some ReducerOf<Self> {
        BindingReducer()
        Reduce { state, action in
            switch action {
            case .binding(\.query):
                let keyword = state.query.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !keyword.isEmpty else {
                    state.result = nil
                    state.notFound = false
                    state.isSearching = false
                    return .cancel(id: CancelID.search)
                }
                state.isSearching = true
                state.notFound = false
                return .run { [clock, searchClient] send in
                    try await clock.sleep(for: .milliseconds(300)) // 防抖:连续输入只查最后一次
                    let result = try await searchClient.search(keyword)
                    await send(.searchResponse(result))
                } catch: { _, send in
                    await send(.searchResponse(nil))
                }
                .cancellable(id: CancelID.search, cancelInFlight: true)

            case let .searchResponse(result):
                state.isSearching = false
                state.result = result
                state.notFound = result == nil
                state.requestSent = false // 新结果重置申请态
                return .none

            case .addButtonTapped:
                guard let result = state.result, !result.isFriend, !state.requestSent else { return .none }
                return .run { [friendRequestClient] send in
                    try await friendRequestClient.send(result.userId)
                    await send(.addCompleted)
                } catch: { _, _ in
                    // 发起失败保持可重试,不改 requestSent。
                }

            case .addCompleted:
                state.requestSent = true
                return .none

            case .closeTapped:
                return .send(.delegate(.close))

            case .binding, .delegate:
                return .none
            }
        }
    }
}
