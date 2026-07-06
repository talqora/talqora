import Foundation

// 鉴权相关的共享错误。众多 client 在拿不到 userId / token 时抛 .notAuthenticated,
// loadErrorMessage 也据此给「登录已过期」文案。放在 Core(与 APIError 并列),供各层共享。
public enum AuthError: Error, Equatable {
    case notAuthenticated
}
