import Foundation

// 把底层错误转成给用户看的人话,供列表/详情「加载失败」三态的错误文案统一使用。
// 不把网络失败/服务端错误静默成空态(§3:empty 不能长得像 error)。
func loadErrorMessage(_ error: Error) -> String {
    if let apiError = error as? APIError {
        switch apiError {
        case .unauthorized:
            return "登录已过期,请重新登录"
        case let .server(message):
            return message
        case .transport:
            return "网络异常,请检查网络后重试"
        case .http, .decoding, .invalidURL:
            return "加载失败,请稍后重试"
        }
    }
    if case AuthError.notAuthenticated = error {
        return "登录已过期,请重新登录"
    }
    return "加载失败,请稍后重试"
}
