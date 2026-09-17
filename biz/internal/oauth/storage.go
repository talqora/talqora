package oauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/our-chat/biz/internal/store"
)

// storage.go:oauth_codes / oauth_refresh_tokens CRUD,核心是 RT rotation + reuse 检测
// (对齐 server/src/oauth/storage.ts)。

// OAuthCode 授权码模型(types.ts:22-33)。
type OAuthCode struct {
	Code                string
	ClientID            string
	UserID              int64
	RedirectURI         string
	CodeChallenge       string
	CodeChallengeMethod string
	Scope               string
	Nonce               *string
	ExpiresAt           time.Time
	Used                bool
}

// OAuthRefreshToken 刷新令牌模型(types.ts:35-47)。
type OAuthRefreshToken struct {
	Jti          string
	FamilyID     string
	ClientID     string
	UserID       int64
	Scope        string
	IssuedAt     time.Time
	ExpiresAt    time.Time
	Revoked      bool
	RotatedTo    *string
	RotatedAt    *time.Time
	RevokeReason *string
}

// generateOpaqueID 48 字节随机 → base64url(约 86 字符,storage.ts:13-15)。
func generateOpaqueID() string {
	b := make([]byte, 48)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// NewJti 令牌 jti(storage.ts:17-19)。
func NewJti(prefix string) string {
	return prefix + "-" + randomUUID()
}

// NewFamilyID RT 家族 id(storage.ts:21-23)。
func NewFamilyID() string {
	return "fam-" + randomUUID()
}

// CreateCode 生成授权码入库(storage.ts:42-68),返回 code。
func CreateCode(ctx context.Context, input struct {
	ClientID            string
	UserID              int64
	RedirectURI         string
	CodeChallenge       string
	CodeChallengeMethod string
	Scope               string
	Nonce               *string
	TTLSec              int
}) (string, error) {
	code := generateOpaqueID()
	expiresAt := time.Now().Add(time.Duration(input.TTLSec) * time.Second)
	_, err := store.PG().Exec(ctx, `
		INSERT INTO oauth_codes
			(code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, scope, nonce, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		code, input.ClientID, input.UserID, input.RedirectURI, input.CodeChallenge,
		input.CodeChallengeMethod, input.Scope, input.Nonce, expiresAt)
	return code, err
}

// ConsumeCode 原子「取出 + 标 used」(storage.ts:71-79):WHERE used=false 防并发重放。
func ConsumeCode(ctx context.Context, code string) (*OAuthCode, error) {
	tag, err := store.PG().Exec(ctx,
		"UPDATE oauth_codes SET used = true WHERE code = $1 AND used = false", code)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, nil
	}
	var c OAuthCode
	err = store.PG().QueryRow(ctx, `
		SELECT code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method,
			scope, nonce, expires_at, used
		FROM oauth_codes WHERE code = $1`, code,
	).Scan(&c.Code, &c.ClientID, &c.UserID, &c.RedirectURI, &c.CodeChallenge,
		&c.CodeChallengeMethod, &c.Scope, &c.Nonce, &c.ExpiresAt, &c.Used)
	if isNoRowsErr(err) {
		return nil, nil
	}
	return &c, err
}

// FindRefreshToken 按 jti 查 RT(storage.ts:99-102)。
func FindRefreshToken(ctx context.Context, jti string) (*OAuthRefreshToken, error) {
	var rt OAuthRefreshToken
	err := store.PG().QueryRow(ctx, `
		SELECT jti, family_id, client_id, user_id, scope, issued_at, expires_at,
			revoked, rotated_to, rotated_at, revoke_reason
		FROM oauth_refresh_tokens WHERE jti = $1`, jti,
	).Scan(&rt.Jti, &rt.FamilyID, &rt.ClientID, &rt.UserID, &rt.Scope, &rt.IssuedAt,
		&rt.ExpiresAt, &rt.Revoked, &rt.RotatedTo, &rt.RotatedAt, &rt.RevokeReason)
	if isNoRowsErr(err) {
		return nil, nil
	}
	return &rt, err
}

// InsertRefreshToken 登记 RT(storage.ts:104-122)。
func InsertRefreshToken(ctx context.Context, jti, familyID, clientID string, userID int64, scope string, expiresAt time.Time) error {
	_, err := store.PG().Exec(ctx, `
		INSERT INTO oauth_refresh_tokens (jti, family_id, client_id, user_id, scope, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		jti, familyID, clientID, userID, scope, expiresAt)
	return err
}

// RotateRefreshToken 原子 rotation(storage.ts:126-135):
// WHERE rotatedTo IS NULL AND revoked=false,影响 0 行 = 并发被抢 = 重用攻击。
func RotateRefreshToken(ctx context.Context, oldJti, newJti string) (bool, error) {
	tag, err := store.PG().Exec(ctx, `
		UPDATE oauth_refresh_tokens SET rotated_to = $2, rotated_at = now(), revoke_reason = 'rotation'
		WHERE jti = $1 AND rotated_to IS NULL AND revoked = false`,
		oldJti, newJti)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// InvalidateFamily 家族撤销(storage.ts:137-143)。
func InvalidateFamily(ctx context.Context, familyID, reason string) (int, error) {
	tag, err := store.PG().Exec(ctx, `
		UPDATE oauth_refresh_tokens SET revoked = true, revoke_reason = $2
		WHERE family_id = $1 AND revoked = false`, familyID, reason)
	return int(tag.RowsAffected()), err
}

// RevokeRefreshTokenByJti 按 jti 撤销(storage.ts:145-154)。
func RevokeRefreshTokenByJti(ctx context.Context, jti, reason string) (bool, error) {
	tag, err := store.PG().Exec(ctx, `
		UPDATE oauth_refresh_tokens SET revoked = true, revoke_reason = $2
		WHERE jti = $1 AND revoked = false`, jti, reason)
	return tag.RowsAffected() == 1, err
}

// CleanupExpiredCodes 清理过期/已用 code(storage.ts:168-180,后台 5min 一次)。
func CleanupExpiredCodes(ctx context.Context) (int, error) {
	now := time.Now()
	oneDayAgo := now.Add(-24 * time.Hour)
	tag, err := store.PG().Exec(ctx, `
		DELETE FROM oauth_codes
		WHERE (used = false AND expires_at < $1) OR (used = true AND expires_at < $2)`,
		now, oneDayAgo)
	return int(tag.RowsAffected()), err
}

// CleanupExpiredRefreshTokens revoked 保留 7 天作审计(storage.ts:183-195)。
func CleanupExpiredRefreshTokens(ctx context.Context) (int, error) {
	now := time.Now()
	sevenDaysAgo := now.Add(-7 * 24 * time.Hour)
	tag, err := store.PG().Exec(ctx, `
		DELETE FROM oauth_refresh_tokens
		WHERE (revoked = false AND expires_at < $1) OR (revoked = true AND issued_at < $2)`,
		now, sevenDaysAgo)
	return int(tag.RowsAffected()), err
}

// StartCleanupLoop 后台定时清理(code 5min;RT 每小时顺带)。
func StartCleanupLoop(ctx context.Context) {
	go func() {
		codeTicker := time.NewTicker(5 * time.Minute)
		rtTicker := time.NewTicker(1 * time.Hour)
		defer codeTicker.Stop()
		defer rtTicker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-codeTicker.C:
				if n, err := CleanupExpiredCodes(ctx); err != nil {
					fmt.Printf("oauth code cleanup 失败: %v\n", err)
				} else if n > 0 {
					fmt.Printf("oauth code cleanup: 删除 %d 条\n", n)
				}
			case <-rtTicker.C:
				if n, err := CleanupExpiredRefreshTokens(ctx); err != nil {
					fmt.Printf("oauth rt cleanup 失败: %v\n", err)
				} else if n > 0 {
					fmt.Printf("oauth rt cleanup: 删除 %d 条\n", n)
				}
			}
		}
	}()
}
