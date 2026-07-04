import ComposableArchitecture

// 界面与显示:外观 + 语言,纯 @AppStorage 驱动,无业务状态。作为导航栈目的地存在。
@Reducer
struct AppearanceFeature {
    @ObservableState
    struct State: Equatable {}
    enum Action: Equatable {}
    var body: some ReducerOf<Self> {
        EmptyReducer()
    }
}
