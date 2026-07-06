import Foundation
@testable import Core
import Testing
@testable import OurChat

struct APIClientTests {
    private func httpResponse(status: Int) throws -> HTTPURLResponse {
        let url = try #require(URL(string: "http://localhost:3007/x"))
        return try #require(
            HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)
        )
    }

    @Test
    func makeURLRequestBuildsURLMethodHeadersBody() throws {
        let request = APIRequest(
            method: .post,
            path: "/api/login",
            query: [URLQueryItem(name: "client", value: "mobile")],
            headers: ["Content-Type": "application/json"],
            body: Data("hello".utf8)
        )
        let urlRequest = try APIClient.makeURLRequest(request, environment: .dev)

        #expect(urlRequest.url?.absoluteString == "http://localhost:3007/api/login?client=mobile")
        #expect(urlRequest.httpMethod == "POST")
        #expect(urlRequest.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(urlRequest.httpBody == Data("hello".utf8))
    }

    @Test
    func makeURLRequestNormalizesPathWithoutLeadingSlash() throws {
        let urlRequest = try APIClient.makeURLRequest(.get("oauth/refresh"), environment: .dev)
        #expect(urlRequest.url?.absoluteString == "http://localhost:3007/oauth/refresh")
    }

    @Test
    func mapResponseReturnsDataOnSuccess() throws {
        let body = Data("ok".utf8)
        let mapped = try APIClient.mapResponse(data: body, response: httpResponse(status: 200))
        #expect(mapped == body)
    }

    @Test
    func mapResponseThrowsUnauthorizedOn401() throws {
        let response = try httpResponse(status: 401)
        #expect(throws: APIError.unauthorized) {
            try APIClient.mapResponse(data: Data(), response: response)
        }
    }

    @Test
    func mapResponseThrowsHTTPOnClientError() throws {
        let response = try httpResponse(status: 404)
        #expect(throws: APIError.http(status: 404, body: Data())) {
            try APIClient.mapResponse(data: Data(), response: response)
        }
    }

    @Test
    func mapResponseThrowsHTTPOnServerError() throws {
        let response = try httpResponse(status: 500)
        #expect(throws: APIError.http(status: 500, body: Data())) {
            try APIClient.mapResponse(data: Data(), response: response)
        }
    }

    @Test
    func sendDecodesSuccessBody() async throws {
        struct Box: Decodable, Equatable { var value: Int }
        let client = APIClient(perform: { _ in Data(#"{"value":42}"#.utf8) })
        let box: Box = try await client.send(.get("/x"), decoding: Box.self)
        #expect(box == Box(value: 42))
    }

    @Test
    func sendMapsDecodingFailure() async {
        struct Box: Decodable { var value: Int }
        let client = APIClient(perform: { _ in Data("not json".utf8) })
        await #expect(throws: APIError.self) {
            let _: Box = try await client.send(.get("/x"), decoding: Box.self)
        }
    }
}
