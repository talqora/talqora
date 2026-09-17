package oauth

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
)

func isNoRowsErr(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func joinSpaces(parts []string) string { return strings.Join(parts, " ") }

func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }

// randomUUID 生成 UUIDv4(jti/family_id/object key 用)。
func randomUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b)
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}
