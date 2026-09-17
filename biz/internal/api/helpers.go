package api

import "strconv"

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
