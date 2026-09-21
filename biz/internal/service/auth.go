// Package service 是业务逻辑层(接口化,预留拆分边界)。
// auth.go:会话 JWT(HS256)签发/验签与用户查询,语义对齐 server/src/middleware/auth.ts 与 routes/login.ts。
package service

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/our-chat/biz/internal/store"
)

// AuthClaims 会话令牌 payload:{ id, username }(与 Node jsonwebtoken 签发一致)。
type AuthClaims struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}

// SignSessionToken 签发会话 token。expiresIn 为 "7d"/"1h"(Node jwt.sign 同参)。
// 26-9-21 修复:time.ParseDuration 不支持 "d" 天单位(仅 ns/us/ms/s/m/h),"7d" 必报错——
// 导致「记住我」登录 500(实测 remember=true → 500,false → 200)。补 "d" 解析:1d=24h。
func SignSessionToken(secret []byte, id int64, username, expiresIn string) (string, error) {
	d, err := parseExpires(expiresIn)
	if err != nil {
		return "", fmt.Errorf("JWT_EXPIRES_IN 非法: %w", err)
	}
	now := time.Now()
	claims := AuthClaims{
		ID:       id,
		Username: username,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(d)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(secret)
}

// parseExpires 解析有效期:兼容 "d" 天单位(Node jwt.sign 的 "7d" 语义),其余走 time.ParseDuration。
func parseExpires(expiresIn string) (time.Duration, error) {
	if strings.HasSuffix(expiresIn, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(expiresIn, "d"))
		if err != nil {
			return 0, err
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	return time.ParseDuration(expiresIn)
}

// VerifySessionToken 验签并解析会话 token。
// 返回 error 区分过期(TokenExpiredError 等价 Node)与其它无效(JsonWebTokenError 等价)。
func VerifySessionToken(secret []byte, token string) (*AuthClaims, error) {
	claims := &AuthClaims{}
	_, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("非预期的签名算法: %v", t.Header["alg"])
		}
		return secret, nil
	})
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, err
		}
		return nil, err
	}
	return claims, nil
}

// DecodeSessionTokenWithoutVerify 仅解码不验签(refresh 对过期 token 解 payload 用,对齐 login.ts:81)。
func DecodeSessionTokenWithoutVerify(token string) (*AuthClaims, error) {
	claims := &AuthClaims{}
	parser := jwt.NewParser(jwt.WithoutClaimsValidation())
	_, _, err := parser.ParseUnverified(token, claims)
	if err != nil {
		return nil, err
	}
	return claims, nil
}

// HashPassword bcrypt cost 12(与 Node 一致)。
func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), 12)
	return string(b), err
}

// ComparePassword bcrypt 比对。
func ComparePassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// UserProfile 鉴权中间件挂到请求上的用户资料(auth.ts:60 的 select 字段集)。
// nullable 字段用 *string 直接输出 null(与 Prisma→JSON 行为一致)。
type UserProfile struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Email    *string `json:"email"`
	Nickname *string `json:"nickname"`
	Avatar   *string `json:"avatar"`
	Status   string  `json:"status"`
}

// FindActiveUser 按 id 查未删除用户(auth.ts:58-61)。不存在返回 nil。
func FindActiveUser(ctx context.Context, id int64) (*UserProfile, error) {
	var u UserProfile
	err := store.RO().QueryRow(ctx, `
		SELECT id, username, email, nickname, avatar, status
		FROM users WHERE id = $1 AND status <> 'deleted'`, id,
	).Scan(&u.ID, &u.Username, &u.Email, &u.Nickname, &u.Avatar, &u.Status)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &u, nil
}
