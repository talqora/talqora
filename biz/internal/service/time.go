package service

import "time"

// JSONTime 输出与 Node 的 Date.toJSON 对齐:UTC 毫秒格式 "2026-09-16T12:34:56.000Z"
// (Prisma DateTime → JS Date → JSON 序列化的形态;timestamptz(0) 毫秒恒为 000)。
// 可空时间列用 *JSONTime(pgx 扫描 NULL 为 nil,JSON 输出 null)。
type JSONTime struct{ time.Time }

// MarshalJSON 实现毫秒格式 UTC 输出;零值输出 null(对齐 nullable 时间列)。
func (t JSONTime) MarshalJSON() ([]byte, error) {
	if t.Time.IsZero() {
		return []byte("null"), nil
	}
	return []byte(`"` + t.Time.UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}
