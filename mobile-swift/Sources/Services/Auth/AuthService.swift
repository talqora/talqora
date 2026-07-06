import Dependencies
import Core
import Models
import DependenciesMacros
import Foundation

@DependencyClient
public struct AuthService: Sendable {
    public var login: @Sendable (_ username: String, _ password: String, _ remember: Bool) async throws -> AuthTokens
    // 注册:成功不返回 token(服务端不自动登录),注册后仍需登录。
    public var register: @Sendable (_ username: String, _ email: String, _ password: String) async throws -> Void
    // 注册前唯一性预检(对齐 web):返回 true 表示「已存在」。
    public var checkUsername: @Sendable (_ username: String) async throws -> Bool
    public var checkEmail: @Sendable (_ email: String) async throws -> Bool
    public var refresh: @Sendable () async throws -> AuthTokens
    public var logout: @Sendable () async throws -> Void
}

private struct ExistsResult: Decodable { let exists: Bool }

private struct LoginBody: Encodable {
    public var username: String
    public var password: String
    public var remember: Bool
}

private struct RegisterBody: Encodable {
    public var username: String
    public var email: String
    public var password: String
}

// 服务端 /api/login、/api/refresh 的 data 形如 { ...user, token }。原生端只取 token 走 Bearer。
private struct TokenData: Decodable {
    public var token: String
}

extension AuthService: DependencyKey {
    public static let liveValue = AuthService(
        login: { username, password, remember in
            @Dependency(\.baseAPIClient) var apiClient
            @Dependency(\.keychain) var keychain
            let request = try APIRequest.post(
                "/api/login",
                json: LoginBody(username: username, password: password, remember: remember)
            )
            let data = try await apiClient.sendUnwrapping(request, as: TokenData.self)
            // 服务端为单 JWT 模型(刷新即重签),无独立 refresh token;两处都存同一 token 以兼容 Keychain 结构。
            let tokens = AuthTokens(accessToken: data.token, refreshToken: data.token)
            try keychain.save(tokens.accessToken, .accessToken)
            try keychain.save(tokens.refreshToken, .refreshToken)
            return tokens
        },
        register: { username, email, password in
            @Dependency(\.baseAPIClient) var apiClient
            struct RegisterResult: Decodable { let success: Bool }
            let request = try APIRequest.post(
                "/api/register",
                json: RegisterBody(username: username, email: email, password: password)
            )
            do {
                // 201 成功:忽略返回的 user 数据。
                _ = try await apiClient.send(request, decoding: APIResponse<RegisterResult>.self)
            } catch let APIError.http(_, body) {
                // 400/409:抽取服务端 message(用户名已存在 / 邮箱格式不正确 …)透给用户。
                throw APIError.server(message: registerErrorMessage(from: body))
            }
        },
        checkUsername: { username in
            @Dependency(\.baseAPIClient) var apiClient
            let request = APIRequest.get("/api/check-username", query: [URLQueryItem(name: "username", value: username)])
            return try await apiClient.send(request, decoding: ExistsResult.self).exists
        },
        checkEmail: { email in
            @Dependency(\.baseAPIClient) var apiClient
            let request = APIRequest.get("/api/check-email", query: [URLQueryItem(name: "email", value: email)])
            return try await apiClient.send(request, decoding: ExistsResult.self).exists
        },
        refresh: {
            @Dependency(\.baseAPIClient) var apiClient
            @Dependency(\.keychain) var keychain
            guard let current = try keychain.load(.accessToken) else {
                throw AuthError.notAuthenticated
            }
            // /api/refresh 接受 Bearer(免 CSRF),凭当前 token 重签。
            var request = APIRequest(method: .post, path: "/api/refresh")
            request.headers["Authorization"] = "Bearer \(current)"
            let data = try await apiClient.sendUnwrapping(request, as: TokenData.self)
            let tokens = AuthTokens(accessToken: data.token, refreshToken: data.token)
            try keychain.save(tokens.accessToken, .accessToken)
            try keychain.save(tokens.refreshToken, .refreshToken)
            return tokens
        },
        logout: {
            @Dependency(\.keychain) var keychain
            try keychain.delete(.accessToken)
            try keychain.delete(.refreshToken)
        }
    )
}

// 从注册失败响应体里抽服务端 message(优于笼统「请求失败」)。
private func registerErrorMessage(from body: Data?) -> String {
    struct Envelope: Decodable { let message: String? }
    if let body, let envelope = try? JSONDecoder().decode(Envelope.self, from: body),
       let message = envelope.message {
        return message
    }
    return "注册失败,请稍后重试"
}

extension DependencyValues {
    public var authService: AuthService {
        get { self[AuthService.self] }
        set { self[AuthService.self] = newValue }
    }
}
