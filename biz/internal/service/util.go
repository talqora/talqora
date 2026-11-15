package service

import (
	"crypto/rand"
	"fmt"
	"log/slog"
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

// nowRFC3339 事件里统一用的时间字符串(与 api 侧 nowISOString 同格式)。
func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }

// LogWarn 统一告警日志(service 层不依赖 api 的 slogWarn)。
func LogWarn(msg string, err error) {
	slog.Warn(msg, "err", err)
}

// newUUID 生成 UUIDv4,用作 clientMsgId 幂等键。
func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
