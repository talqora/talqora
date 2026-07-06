import Foundation

public struct APIRequest: Sendable, Equatable {
    public enum Method: String, Sendable, Equatable {
        case get = "GET"
        case post = "POST"
        case put = "PUT"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    public var method: Method
    public var path: String
    public var query: [URLQueryItem]
    public var headers: [String: String]
    public var body: Data?

    public init(
        method: Method = .get,
        path: String,
        query: [URLQueryItem] = [],
        headers: [String: String] = [:],
        body: Data? = nil
    ) {
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.body = body
    }
}

extension APIRequest {
    public static func get(_ path: String, query: [URLQueryItem] = []) -> APIRequest {
        APIRequest(method: .get, path: path, query: query)
    }

    public static func post(
        _ path: String,
        json body: some Encodable,
        encoder: JSONEncoder = JSONEncoder()
    ) throws -> APIRequest {
        APIRequest(
            method: .post,
            path: path,
            headers: ["Content-Type": "application/json"],
            body: try encoder.encode(body)
        )
    }

    public static func put(
        _ path: String,
        json body: some Encodable,
        encoder: JSONEncoder = JSONEncoder()
    ) throws -> APIRequest {
        APIRequest(
            method: .put,
            path: path,
            headers: ["Content-Type": "application/json"],
            body: try encoder.encode(body)
        )
    }
}
