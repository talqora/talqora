import Foundation

/// agent 小程序专用 URLSession —— 与主 App 的 `URLSession.shared` / socket.io 连接池**隔离**。
///
/// 为什么必须隔离:socket.io 长轮询与 agent 的 SSE 都是长连接,若都跑在 `URLSession.shared` 上,
/// 会把该主机的连接池占满;此时 REST GET(会话/文档列表)只能**排队等连接**,而排队时长受
/// `timeoutIntervalForResource`(默认 7 天)约束、不受 `timeoutIntervalForRequest`(60s)约束,
/// 表现为"一直转圈"(与网络无关,退出小程序取消 SSE 释放连接后重进才好)。独立会话即独立连接池,
/// 互不挤占;再配合较短的 resource 超时,即使异常也**快速失败可重试**,而非无限挂起。
public enum AgentHTTP {
    /// REST / token mint:短超时,连排队也在 30s 内失败(可重试),不无限挂起。
    static let rest: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20   // 单请求无数据 20s 失败
        cfg.timeoutIntervalForResource = 30  // 含排队的整体上限 30s(关键:不再默认 7 天)
        cfg.waitsForConnectivity = false     // 无网直接失败,不挂起
        cfg.httpMaximumConnectionsPerHost = 8
        return URLSession(configuration: cfg)
    }()

    /// SSE 流式 / 文件上传:token 间隔容忍更久,整体上限放宽(长回答/多步任务/大文件)。
    static let stream: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 3600
        cfg.waitsForConnectivity = false
        cfg.httpMaximumConnectionsPerHost = 8
        return URLSession(configuration: cfg)
    }()
}
