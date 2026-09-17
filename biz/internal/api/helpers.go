package api

import (
	"bytes"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// toStr 把 JSON 值宽松转字符串(数字/字符串均可)。
func toStr(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	case nil:
		return ""
	default:
		return ""
	}
}

func strconvFormatInt(v int64) string { return strconv.FormatInt(v, 10) }

func itoa(v int) string { return strconv.Itoa(v) }

// nowISOString 与 Node new Date().toISOString() 对齐的毫秒 UTC 字符串。
func nowISOString() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func trimSpace(s string) string { return strings.TrimSpace(s) }

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func slogWarn(msg string, err error) { slog.Default().Warn(msg, "err", err) }

// readerFromBytes 字节 → io.Reader(imaging.Decode 用)。
func readerFromBytes(b []byte) *bytes.Reader { return bytes.NewReader(b) }

// newBytesBuffer 内存 buffer(imaging.Encode 输出)。
func newBytesBuffer() *bytes.Buffer { return &bytes.Buffer{} }

// toFloat JSON 数字宽松转 float64。
func toFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		f, _ := strconv.ParseFloat(t, 64)
		return f
	default:
		return 0
	}
}
