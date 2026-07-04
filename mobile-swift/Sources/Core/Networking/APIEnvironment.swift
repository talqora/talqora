import Foundation

struct APIEnvironment: Sendable, Equatable {
    var baseURLString: String
}

extension APIEnvironment {
    // 本地开发:需先在 mac 上起 server(cd server && npm run dev)
    static let dev = APIEnvironment(baseURLString: "http://localhost:3007")
    // 生产:部署在 tujiang.tech(HTTPS,socket 自动走 wss);证书为 Let's Encrypt,ATS 达标无需例外
    static let prod = APIEnvironment(baseURLString: "https://tujiang.tech")

    // 全局当前环境:API 与 socket 统一取此值,避免两处各自硬编码 base URL。
    // 默认连生产;本地起了 server 就把这行改成 .dev。
    static let current: APIEnvironment = .prod
}
