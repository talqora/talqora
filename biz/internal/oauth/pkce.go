package oauth

import (
	"crypto/sha256"
	"encoding/base64"
	"regexp"
)

// pkce.go:PKCE 校验工具,RFC 7636(对齐 server/src/oauth/pkce.ts)。

var verifierRe = regexp.MustCompile(`^[A-Za-z0-9\-._~]{43,128}$`)

// IsValidVerifier verifier 是 [A-Za-z0-9-._~] 字符,长度 43-128(RFC 7636 §4.1)。
func IsValidVerifier(verifier string) bool {
	return verifierRe.MatchString(verifier)
}

// DeriveS256Challenge base64url(SHA256(verifier))。
func DeriveS256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// VerifyS256 比对挑战(非必需 timing-safe,但代价低就用)。
func VerifyS256(verifier, storedChallenge string) bool {
	if !IsValidVerifier(verifier) {
		return false
	}
	return timingSafeEqualStr(DeriveS256Challenge(verifier), storedChallenge)
}

func timingSafeEqualStr(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var result byte
	for i := 0; i < len(a); i++ {
		result |= a[i] ^ b[i]
	}
	return result == 0
}

// decodeBase64URL base64url 解码(无填充容忍)。
func decodeBase64URL(s string) []byte {
	pad := (4 - len(s)%4) % 4
	for i := 0; i < pad; i++ {
		s += "="
	}
	out, _ := base64.URLEncoding.DecodeString(s)
	return out
}
