package service

import (
	"strconv"
	"time"
)

// nowMillis 当前 unix 毫秒(presence 的 score 单位与 Node Date.now() 对齐)。
func nowMillis() int64 { return time.Now().UnixMilli() }

func itoa64(v int64) string { return strconv.FormatInt(v, 10) }

// formatAny 把 JSON 宽松类型转字符串(mentions 里可能是 number/string)。
func formatAny(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	default:
		return ""
	}
}

func parseInt64(s string) (int64, error) { return strconv.ParseInt(s, 10, 64) }

