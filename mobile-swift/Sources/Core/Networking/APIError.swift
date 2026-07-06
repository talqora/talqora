import Foundation

public enum APIError: Error, Equatable, Sendable {
    case invalidURL
    case transport(message: String)
    case unauthorized
    case http(status: Int, body: Data?)
    case decoding(message: String)
    case server(message: String) // {success:false} 业务失败,携服务端 message
}
