import Dependencies
import DependenciesMacros
import Foundation

@DependencyClient
public struct APIClient: Sendable {
    public var perform: @Sendable (_ request: APIRequest) async throws -> Data
}

extension APIClient {
    public func send<Response: Decodable>(
        _ request: APIRequest,
        decoding _: Response.Type,
        decoder: JSONDecoder = .ourchatAPI
    ) async throws -> Response {
        let data = try await perform(request)
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIError.decoding(message: String(describing: error))
        }
    }
}

extension APIClient {
    static func live(environment: APIEnvironment, session: URLSession = .shared) -> APIClient {
        APIClient(perform: { request in
            let urlRequest = try makeURLRequest(request, environment: environment)
            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await session.data(for: urlRequest)
            } catch {
                throw APIError.transport(message: error.localizedDescription)
            }
            return try mapResponse(data: data, response: response)
        })
    }

    static func makeURLRequest(_ request: APIRequest, environment: APIEnvironment) throws -> URLRequest {
        guard var components = URLComponents(string: environment.baseURLString) else {
            throw APIError.invalidURL
        }
        let base = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
        let path = request.path.hasPrefix("/") ? request.path : "/" + request.path
        components.path = base + path
        if !request.query.isEmpty {
            components.queryItems = request.query
        }
        guard let url = components.url else {
            throw APIError.invalidURL
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.httpBody = request.body
        for (key, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }
        return urlRequest
    }

    static func mapResponse(data: Data, response: URLResponse) throws -> Data {
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport(message: "Non-HTTP response")
        }
        switch http.statusCode {
        case 200 ..< 300:
            return data
        case 401:
            throw APIError.unauthorized
        default:
            throw APIError.http(status: http.statusCode, body: data)
        }
    }
}

extension APIClient: DependencyKey {
    public static let liveValue: APIClient = {
        let coordinator = RefreshCoordinator()
        return APIClient(perform: { request in
            @Dependency(\.baseAPIClient) var base
            @Dependency(\.keychain) var keychain
            // 依赖倒置:刷新走 Core 自己的 tokenRefresher 抽象,不直连 Services 的 authService。
            @Dependency(\.tokenRefresher) var refresher
            return try await authenticatedPerform(
                request,
                base: base,
                keychain: keychain,
                coordinator: coordinator,
                refresh: { try await refresher.refresh() },
                onRefreshFailure: { await refresher.onRefreshFailure() }
            )
        })
    }()
}

extension DependencyValues {
    public var apiClient: APIClient {
        get { self[APIClient.self] }
        set { self[APIClient.self] = newValue }
    }
}
