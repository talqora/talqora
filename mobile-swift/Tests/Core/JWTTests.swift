import Foundation
import Core
import Testing
@testable import OurChat

struct JWTTests {
    private func makeToken(payloadJSON: String) -> String {
        func b64url(_ s: String) -> String {
            Data(s.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return "\(b64url(#"{"alg":"HS256","typ":"JWT"}"#)).\(b64url(payloadJSON)).signature"
    }

    @Test
    func decodesIntegerUserId() {
        let token = makeToken(payloadJSON: #"{"id":42,"username":"neo"}"#)
        #expect(JWT.decodeUserId(token) == 42)
    }

    @Test
    func decodesStringUserId() {
        let token = makeToken(payloadJSON: #"{"id":"7"}"#)
        #expect(JWT.decodeUserId(token) == 7)
    }

    @Test
    func returnsNilForMalformedToken() {
        #expect(JWT.decodeUserId("not-a-jwt") == nil)
        #expect(JWT.decodeUserId("") == nil)
        #expect(JWT.decodeUserId("a.b.c") == nil)
    }
}
