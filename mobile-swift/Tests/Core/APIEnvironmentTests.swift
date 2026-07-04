import Testing
@testable import OurChat

struct APIEnvironmentTests {
    // 回归护栏:全局环境必须指向生产,别再退回 localhost —— 否则真机/模拟器连不上后端(NSURLError -1004)。
    @Test
    func currentPointsToProduction() {
        #expect(APIEnvironment.current == .prod)
    }

    // 生产必须 HTTPS:socket.io 据此自动升级 wss,且满足 iOS ATS(无需 Info.plist 例外)。
    @Test
    func productionUsesHTTPS() {
        #expect(APIEnvironment.prod.baseURLString == "https://tujiang.tech")
        #expect(APIEnvironment.prod.baseURLString.hasPrefix("https://"))
    }

    @Test
    func devTargetsLocalhost() {
        #expect(APIEnvironment.dev.baseURLString == "http://localhost:3007")
    }
}
