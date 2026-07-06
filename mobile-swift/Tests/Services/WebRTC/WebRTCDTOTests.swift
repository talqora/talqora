import Foundation
@testable import Services
import Testing
@testable import OurChat

struct WebRTCDTOTests {
    @Test func iceCandidateDecodesWireShape() throws {
        let json = #"{"candidate":"candidate:1 1 udp 2130706431 1.2.3.4 5000 typ host","sdpMlineIndex":0,"sdpMid":"0"}"#
        let dto = try JSONDecoder().decode(IceCandidateDTO.self, from: Data(json.utf8))
        #expect(dto.candidate.hasPrefix("candidate:1"))
        #expect(dto.sdpMlineIndex == 0)
        #expect(dto.sdpMid == "0")
    }

    @Test func sessionDescriptionRoundTrips() throws {
        let dto = SessionDescriptionDTO(type: "offer", sdp: "v=0...")
        let data = try JSONEncoder().encode(dto)
        let back = try JSONDecoder().decode(SessionDescriptionDTO.self, from: data)
        #expect(back == dto)
    }
}
