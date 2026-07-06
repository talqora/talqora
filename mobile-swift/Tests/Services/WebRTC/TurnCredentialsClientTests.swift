import Foundation
@testable import Services
import Testing
@testable import OurChat

struct TurnCredentialsResponseTests {
    @Test func decodesIceServers() throws {
        let json = #"{"iceServers":[{"urls":["stun:tujiang.tech:3478"]},{"urls":["turns:tujiang.tech:5349?transport=tcp"],"username":"u","credential":"c"}],"ttl":86400}"#
        let resp = try JSONDecoder().decode(TurnCredentialsResponse.self, from: Data(json.utf8))
        #expect(resp.iceServers.count == 2)
        #expect(resp.iceServers[1].username == "u")
    }
}
