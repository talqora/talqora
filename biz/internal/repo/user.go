package repo

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/our-chat/biz/internal/db"
)

// ErrConflict 唯一约束冲突(用户名/邮箱/手机号重复)。
var ErrConflict = errors.New("conflict")

// NewUser 注册入参(密码已哈希)。
type NewUser struct {
	Username string
	Email    string
	Phone    *string
	Password string
	Nickname *string
	Avatar   *string
	Bio      *string
}

// CreatedUser 注册返回的最小用户信息。
type CreatedUser struct {
	ID        int64
	Username  string
	Email     *string
	Phone     *string
	Status    string
	CreatedAt time.Time
}

// UserRepo 用户域写路径与唯一性查询。
type UserRepo interface {
	Create(ctx context.Context, in NewUser) (CreatedUser, error)
	ExistsBy(ctx context.Context, col, val string) (bool, error)
	UpdateFields(ctx context.Context, id int64, fields map[string]any) error
}

type userRepo struct{}

func NewUserRepo() UserRepo { return userRepo{} }

func (userRepo) Create(ctx context.Context, in NewUser) (CreatedUser, error) {
	var u CreatedUser
	err := db.PG().QueryRow(ctx, `
		INSERT INTO users (username, email, phone, password, nickname, avatar, bio, status, last_seen)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'online', now())
		RETURNING id, username, email, phone, status, created_at`,
		in.Username, in.Email, in.Phone, in.Password, in.Nickname, in.Avatar, in.Bio,
	).Scan(&u.ID, &u.Username, &u.Email, &u.Phone, &u.Status, &u.CreatedAt)
	if isUniqueViolation(err) {
		return CreatedUser{}, ErrConflict
	}
	if err != nil {
		return CreatedUser{}, err
	}
	return u, nil
}

// ExistsBy 唯一性探针:col 只允许白名单列(由 service 保证),避免拼接注入。
func (userRepo) ExistsBy(ctx context.Context, col, val string) (bool, error) {
	if !userColumnAllowed[col] {
		return false, errors.New("column not allowed")
	}
	var one int64
	err := db.RO().QueryRow(ctx, "SELECT id FROM users WHERE "+col+" = $1", val).Scan(&one)
	if err == nil {
		return true, nil
	}
	if strings.Contains(err.Error(), "no rows") {
		return false, nil
	}
	return false, err
}

// UpdateFields 按白名单列更新资料(列名来自白名单,值走占位符)。
func (userRepo) UpdateFields(ctx context.Context, id int64, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	set := make([]string, 0, len(fields))
	args := make([]any, 0, len(fields)+1)
	i := 1
	for col, v := range fields {
		if !userColumnAllowed[col] {
			continue
		}
		set = append(set, col+" = $"+itoa(i))
		args = append(args, v)
		i++
	}
	if len(set) == 0 {
		return nil
	}
	args = append(args, id)
	_, err := db.PG().Exec(ctx,
		"UPDATE users SET "+strings.Join(set, ", ")+" WHERE id = $"+itoa(i), args...)
	return err
}

// userColumnAllowed 可更新/可查询的列白名单。
var userColumnAllowed = map[string]bool{
	"username": true, "email": true, "phone": true, "password": true,
	"nickname": true, "avatar": true, "bio": true, "gender": true, "status": true,
	"last_seen": true,
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return false
}
