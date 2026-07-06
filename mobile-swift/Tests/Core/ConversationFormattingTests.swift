import Foundation
import Core
import Testing
@testable import OurChat

struct ConversationFormattingTests {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return c
    }

    private func date(_ y: Int, _ mo: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0) -> Date {
        var c = DateComponents()
        c.year = y; c.month = mo; c.day = d; c.hour = h; c.minute = mi
        return calendar.date(from: c)!
    }

    @Test
    func todayShowsClock() {
        let now = date(2026, 6, 25, 10, 0)
        #expect(RelativeTime.label(from: date(2026, 6, 25, 8, 30), now: now, calendar: calendar) == "08:30")
    }

    @Test
    func yesterdayShowsLabel() {
        let now = date(2026, 6, 25, 10, 0)
        #expect(RelativeTime.label(from: date(2026, 6, 24, 23, 0), now: now, calendar: calendar) == "昨天")
    }

    @Test
    func withinWeekShowsWeekday() {
        let now = date(2026, 6, 25, 10, 0)
        let label = RelativeTime.label(from: date(2026, 6, 22, 9, 0), now: now, calendar: calendar)
        #expect(label.hasPrefix("周"))
    }

    @Test
    func olderShowsMonthDay() {
        let now = date(2026, 6, 25, 10, 0)
        #expect(RelativeTime.label(from: date(2026, 6, 10, 9, 0), now: now, calendar: calendar) == "6月10日")
    }

    @Test
    func messagePreviewByType() {
        #expect(MessagePreview.text(content: "hi", type: "text") == "hi")
        #expect(MessagePreview.text(content: "", type: "image") == "[图片]")
        #expect(MessagePreview.text(content: "", type: "file") == "[文件]")
        #expect(MessagePreview.text(content: "", type: "voice") == "[语音]")
    }
}
