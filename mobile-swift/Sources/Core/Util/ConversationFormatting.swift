import Foundation

// 会话列表的时间展示:今天→HH:mm;昨天→"昨天";一周内→周几;更早→M月d日。
// now/calendar 可注入,便于单测稳定。
public enum RelativeTime {
    public static func label(from date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return formatted(date, "HH:mm", calendar)
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return "昨天"
        }
        let from = calendar.startOfDay(for: date)
        let to = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: from, to: to).day ?? 0
        if (0 ..< 7).contains(days) {
            return weekday(date, calendar)
        }
        return formatted(date, "M月d日", calendar)
    }

    private static func formatted(_ date: Date, _ pattern: String, _ calendar: Calendar) -> String {
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = pattern
        return f.string(from: date)
    }

    private static func weekday(_ date: Date, _ calendar: Calendar) -> String {
        let names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
        let index = calendar.component(.weekday, from: date) - 1 // 1=周日
        return names[(index % 7 + 7) % 7]
    }
}

// 会话最后一条消息在列表里的预览文案:非文本消息用占位标签。
public enum MessagePreview {
    public static func text(content: String, type: String) -> String {
        switch type {
        case "text": return content
        case "image": return "[图片]"
        case "file": return "[文件]"
        case "voice": return "[语音]"
        case "video": return "[视频]"
        default: return content.isEmpty ? "[\(type)]" : content
        }
    }
}
