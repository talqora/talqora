import Foundation

public struct SSEFrame: Equatable, Sendable { public var event: String; public var data: String; public init(event: String, data: String) { self.event = event; self.data = data } }

// 增量喂入字符串块,按 SSE 规范(空行分帧,event:/data: 字段,data 多行以 \n 连接)吐出完整帧。
// 半包安全:未遇空行的内容留在缓冲区。
public struct SSEParser {
    private var buffer = ""
    mutating func consume(_ chunk: String) -> [SSEFrame] {
        buffer += chunk
        var frames: [SSEFrame] = []
        while let range = buffer.range(of: "\n\n") {
            let block = String(buffer[buffer.startIndex..<range.lowerBound])
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            if let f = Self.parseBlock(block) { frames.append(f) }
        }
        return frames
    }
    private static func parseBlock(_ block: String) -> SSEFrame? {
        var event = "message"; var dataLines: [String] = []
        for line in block.split(separator: "\n", omittingEmptySubsequences: false) {
            let l = String(line)
            if l.hasPrefix("event:") { event = l.dropFirst(6).trimmingCharacters(in: .whitespaces) }
            else if l.hasPrefix("data:") { dataLines.append(String(l.dropFirst(5).trimmingCharacters(in: .whitespaces))) }
        }
        if dataLines.isEmpty { return nil }
        return SSEFrame(event: event, data: dataLines.joined(separator: "\n"))
    }
}
