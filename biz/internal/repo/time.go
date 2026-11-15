package repo

import (
	"fmt"
	"time"
)

// JSONTime 与 Node 的 Date.toJSON 对齐:UTC 毫秒格式 "2026-09-16T12:34:56.000Z"。
// 定义放在 repo(数据层),service 用类型别名复用,避免 repo→service 的循环依赖。
type JSONTime struct{ time.Time }

func (t JSONTime) MarshalJSON() ([]byte, error) {
	if t.Time.IsZero() {
		return []byte("null"), nil
	}
	return []byte(`"` + t.Time.UTC().Format("2006-01-02T15:04:05.000Z") + `"`), nil
}

func (t *JSONTime) Scan(src any) error {
	switch v := src.(type) {
	case time.Time:
		t.Time = v
		return nil
	case nil:
		t.Time = time.Time{}
		return nil
	default:
		return fmt.Errorf("JSONTime 不支持类型 %T", src)
	}
}
