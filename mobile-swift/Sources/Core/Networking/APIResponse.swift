import Foundation

// our-chat REST 统一信封:{ success, data, message }。
public struct APIResponse<T: Decodable>: Decodable {
    public let success: Bool
    public let data: T?
    public let message: String?
}

extension APIClient {
    // 解信封并取出 data;success=false 或 data 缺失则抛 server 错误(带服务端 message)。
    // 所有领域接口(好友/会话/消息…)统一走这个,避免每处重复解信封。
    public func sendUnwrapping<T: Decodable>(
        _ request: APIRequest,
        as _: T.Type,
        decoder: JSONDecoder = .ourchatAPI
    ) async throws -> T {
        let envelope = try await send(request, decoding: APIResponse<T>.self, decoder: decoder)
        guard envelope.success, let data = envelope.data else {
            throw APIError.server(message: envelope.message ?? "请求失败")
        }
        return data
    }
}

extension JSONDecoder {
    // OpenAPI 生成类型的 date-time 字段是 Foundation.Date,线上是 ISO8601 字符串(可能带毫秒),
    // 普通 JSONDecoder 默认按数字解 Date 会失败,这里统一按 ISO8601(含毫秒兜底)解。
    public static var ourchatAPI: JSONDecoder {
        let decoder = JSONDecoder()
        // ISO8601DateFormatter 非 Sendable,在 @Sendable 解码闭包里就地创建以免捕获。
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            let withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            if let date = withFraction.date(from: raw) ?? plain.date(from: raw) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "无法解析的 ISO8601 日期: \(raw)")
            )
        }
        return decoder
    }
}
