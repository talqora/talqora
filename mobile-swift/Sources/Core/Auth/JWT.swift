import Foundation

// 仅本地解析 JWT 载荷读取 userId(不验签——验签是服务端的职责;客户端只需知道"我是谁")。
public enum JWT {
    public static func decodeUserId(_ token: String) -> Int? {
        let segments = token.split(separator: ".")
        guard segments.count == 3, let payload = base64URLDecode(String(segments[1])) else {
            return nil
        }
        guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            return nil
        }
        switch object["id"] {
        case let id as Int: return id
        case let id as Double: return Int(id)
        case let id as String: return Int(id)
        default: return nil
        }
    }

    private static func base64URLDecode(_ value: String) -> Data? {
        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: base64)
    }
}
