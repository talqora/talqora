import Testing
@testable import Services
import Foundation
@testable import OurChat

struct AgentDTOTests {
    @Test func decodesTokenResponse() throws {
        let d = Data(#"{"access_token":"jwt","token_type":"Bearer","expires_in":900}"#.utf8)
        let r = try JSONDecoder().decode(AgentTokenResponse.self, from: d)
        #expect(r.accessToken == "jwt" && r.expiresIn == 900)
    }
    @Test func decodesChatTokenEvent() throws {
        let e = try ChatStreamEvent.decode(event: "token", data: #"{"type":"token","value":"你"}"#)
        #expect(e == .token("你"))
    }
    @Test func decodesChatDoneEvent() throws {
        let e = try ChatStreamEvent.decode(event: "done", data: #"{"type":"done","messageId":5,"citations":[{"chunkId":1,"documentId":2,"score":0.8}]}"#)
        if case let .done(id, cites) = e { #expect(id == 5 && cites.first?.documentId == 2) } else { Issue.record("wrong case") }
    }
}
