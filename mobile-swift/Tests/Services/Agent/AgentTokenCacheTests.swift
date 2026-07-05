import Testing
import Foundation
@testable import OurChat

struct AgentTokenCacheTests {
    @Test func validWhenNotNearExpiry() {
        let c = AgentTokenCache(token: "t", expiresAt: Date(timeIntervalSinceNow: 120))
        #expect(c.isValid(now: Date(), skew: 30) == true)
    }
    @Test func invalidWithinSkew() {
        let c = AgentTokenCache(token: "t", expiresAt: Date(timeIntervalSinceNow: 20))
        #expect(c.isValid(now: Date(), skew: 30) == false)
    }
}
