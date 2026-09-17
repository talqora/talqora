package oauth

import (
	"encoding/json"
	"log/slog"
	"net/url"
	"time"
)

// audit.go:OAuth 审计日志(对齐 server/src/oauth/audit.ts,stdout 结构化 JSON)。

// AuditLevel 级别。
type AuditLevel string

const (
	AuditInfo  AuditLevel = "INFO"
	AuditWarn  AuditLevel = "WARN"
	AuditError AuditLevel = "ERROR"
)

// defaultLevel 事件默认级别(audit.ts:38-52)。
var defaultLevel = map[string]AuditLevel{
	"client_created":     AuditInfo,
	"code_issued":        AuditInfo,
	"code_exchanged":     AuditInfo,
	"agent_token_issued": AuditInfo,
	"token_refreshed":    AuditInfo,
	"rt_reuse_detected":  AuditWarn,
	"token_revoked":      AuditInfo,
	"client_disabled":    AuditInfo,
	"key_rotation":       AuditInfo,
	"param_invalid":      AuditInfo,
	"grant_rejected":     AuditInfo,
	"client_rejected":    AuditInfo,
	"internal_error":     AuditError,
}

// Audit 输出结构化审计日志(audit.ts:54-65)。
func Audit(fields map[string]any) {
	event, _ := fields["event"].(string)
	level, ok := defaultLevel[event]
	if !ok {
		level = AuditInfo
	}
	record := map[string]any{
		"ts":     time.Now().UTC().Format(time.RFC3339Nano),
		"level":  level,
		"module": "oauth",
	}
	for k, v := range fields {
		record[k] = v
	}
	raw, _ := json.Marshal(record)
	slog.Default().Info(string(raw))
}

// parseURL 解析 URL(供 redirect 构造用)。
func parseURL(raw string) (*url.URL, error) { return url.Parse(raw) }
