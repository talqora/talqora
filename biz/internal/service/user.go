package service

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/our-chat/biz/internal/store"
)

// FullUser users 表全量字段(Prisma User 对齐;BigInt→int64 JSON 输出 number)。
type FullUser struct {
	ID        int64   `json:"id"`
	Username  string  `json:"username"`
	Email     *string `json:"email"`
	Phone     *string `json:"phone"`
	Password  string  `json:"-"`
	Nickname  *string `json:"nickname"`
	Avatar    *string `json:"avatar"`
	Bio       *string `json:"bio"`
	Gender    *string `json:"gender"`
	Status    string     `json:"status"`
	LastSeen  *JSONTime  `json:"lastSeen"`
	CreatedAt JSONTime   `json:"createdAt"`
	UpdatedAt JSONTime   `json:"updatedAt"`
}

// WithoutPassword 返回剔除密码后的用户信息(login.ts:45 语义:...userInfo + token)。
func (u *FullUser) WithoutPassword(token string) map[string]any {
	return map[string]any{
		"id":        u.ID,
		"username":  u.Username,
		"email":     u.Email,
		"phone":     u.Phone,
		"nickname":  u.Nickname,
		"avatar":    u.Avatar,
		"bio":       u.Bio,
		"gender":    u.Gender,
		"status":    u.Status,
		"lastSeen":  u.LastSeen,
		"createdAt": u.CreatedAt,
		"updatedAt": u.UpdatedAt,
		"token":     token,
	}
}

// FindUserByUsername 按 username 查全量用户(login.ts:25)。不存在返回 nil。
func FindUserByUsername(ctx context.Context, username string) (*FullUser, error) {
	var u FullUser
	err := store.PG().QueryRow(ctx, `
		SELECT id, username, email, phone, password, nickname, avatar, bio, gender, status, last_seen, created_at, updated_at
		FROM users WHERE username = $1`, username,
	).Scan(&u.ID, &u.Username, &u.Email, &u.Phone, &u.Password, &u.Nickname, &u.Avatar,
		&u.Bio, &u.Gender, &u.Status, &u.LastSeen, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}
