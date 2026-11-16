package repo

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/our-chat/biz/internal/db"
)

// ErrNotFound 表示记录不存在(上层据此映射 404/业务提示)。
var ErrNotFound = errors.New("not found")

// Friend 好友列表行(含备注与资料)。
type Friend struct {
	UserID   int64
	Username string
	Avatar   *string
	Gender   *string
	Remark   *string
}

// UserCard 用户公开资料(搜索结果/陌生人)。
type UserCard struct {
	ID       int64
	Username string
	Avatar   *string
	Gender   *string
}

// FriendReq 好友请求行(有向:user_id 是发起方,friend_id 是接收方)。
type FriendReq struct {
	ID        int64
	UserID    int64
	FriendID  int64
	Status    string
	Remark    *string
	CreatedAt time.Time
	UpdatedAt time.Time
	Username  *string
	Avatar    *string
}

// FriendRepo 好友域的数据访问接口(只做 SQL 与映射,不含业务规则)。
type FriendRepo interface {
	ListFriends(ctx context.Context, uid int64, p Page) (Result[Friend], error)
	ListReqs(ctx context.Context, uid int64, p Page) (Result[FriendReq], error)
	SearchUser(ctx context.Context, keyword string) (UserCard, error)
	HasRelation(ctx context.Context, uid, fid int64) (bool, error)
	AddRequest(ctx context.Context, uid, fid int64) error
	ReplyRequest(ctx context.Context, uid, fid int64, status string) error
	SetRemark(ctx context.Context, uid, fid int64, remark *string) error
	EnsureSingleConversation(ctx context.Context, convID string) error
	UserBrief(ctx context.Context, uid int64) (UserCard, error)
}

type friendRepo struct{}

// NewFriendRepo 返回默认实现(直接使用连接池单例;后续可注入)。
func NewFriendRepo() FriendRepo { return friendRepo{} }

func (friendRepo) ListFriends(ctx context.Context, uid int64, p Page) (Result[Friend], error) {
	// limit=0 表示「全量」旧语义,不能被默认值覆盖(登录时拉全量好友依赖它)
	// limit 缺省不全量查询好友信息会导致ID 靠后的好友查不到名字
	if p.Limit > 0 {
		p = p.Normalize(50, 200)
	}
	q := "SELECT f.friend_id, u.username, u.avatar, u.gender, f.remark FROM friendships f " +
		"JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1"
	args := []any{uid}
	if p.After > 0 {
		q += " AND f.friend_id > $2"
		args = append(args, p.After)
	}
	q += " ORDER BY f.friend_id"
	if p.Limit > 0 {
		q += " LIMIT " + itoa(p.Limit+1)
	}

	rows, err := db.RO().Query(ctx, q, args...)
	if err != nil {
		return Result[Friend]{}, err
	}
	defer rows.Close()
	var out []Friend
	for rows.Next() {
		var f Friend
		if err := rows.Scan(&f.UserID, &f.Username, &f.Avatar, &f.Gender, &f.Remark); err != nil {
			return Result[Friend]{}, err
		}
		out = append(out, f)
	}
	return paginate(out, p.Limit, func(f Friend) int64 { return f.UserID }), rows.Err()
}

func (friendRepo) ListReqs(ctx context.Context, uid int64, p Page) (Result[FriendReq], error) {
	if p.Limit > 0 {
		p = p.Normalize(30, 200)
	}
	q := "SELECT f.id, f.user_id, f.friend_id, f.status::text, f.remark, f.created_at, f.updated_at, " +
		"u.username, u.avatar FROM friendships f LEFT JOIN users u ON u.id = f.friend_id WHERE f.user_id = $1"
	args := []any{uid}
	if p.After > 0 {
		q += " AND f.id < $2"
		args = append(args, p.After)
	}
	q += " ORDER BY f.id DESC"
	if p.Limit > 0 {
		q += " LIMIT " + itoa(p.Limit+1)
	}

	rows, err := db.RO().Query(ctx, q, args...)
	if err != nil {
		return Result[FriendReq]{}, err
	}
	defer rows.Close()
	var out []FriendReq
	for rows.Next() {
		var r FriendReq
		if err := rows.Scan(&r.ID, &r.UserID, &r.FriendID, &r.Status, &r.Remark,
			&r.CreatedAt, &r.UpdatedAt, &r.Username, &r.Avatar); err != nil {
			return Result[FriendReq]{}, err
		}
		out = append(out, r)
	}
	return paginate(out, p.Limit, func(r FriendReq) int64 { return r.ID }), rows.Err()
}

func (friendRepo) SearchUser(ctx context.Context, keyword string) (UserCard, error) {
	var idKw any
	if n, err := parseInt64(keyword); err == nil {
		idKw = n
	}
	var u UserCard
	err := db.RO().QueryRow(ctx, `
		SELECT id, username, avatar, gender FROM users
		WHERE ($1::bigint IS NOT NULL AND id = $1) OR phone = $2 OR username = $2
		LIMIT 1`, idKw, keyword).Scan(&u.ID, &u.Username, &u.Avatar, &u.Gender)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserCard{}, ErrNotFound
	}
	return u, err
}

func (friendRepo) HasRelation(ctx context.Context, uid, fid int64) (bool, error) {
	var id int64
	err := db.RO().QueryRow(ctx,
		"SELECT id FROM friendships WHERE user_id = $1 AND friend_id = $2", uid, fid).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (friendRepo) UserBrief(ctx context.Context, uid int64) (UserCard, error) {
	var u UserCard
	err := db.RO().QueryRow(ctx,
		"SELECT id, username, avatar, gender FROM users WHERE id = $1", uid).
		Scan(&u.ID, &u.Username, &u.Avatar, &u.Gender)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserCard{}, ErrNotFound
	}
	return u, err
}

// AddRequest 双向写入:发起方 sent、接收方 pending(撞唯一约束即视为重复请求)。
func (friendRepo) AddRequest(ctx context.Context, uid, fid int64) error {
	_, err := db.PG().Exec(ctx, `
		INSERT INTO friendships (user_id, friend_id, status) VALUES
			($1, $2, 'sent'), ($2, $1, 'pending')`, uid, fid)
	return err
}

// ReplyRequest 双向更新状态:sent/pending → accepted/blocked,两个方向保持同一状态。
func (friendRepo) ReplyRequest(ctx context.Context, uid, fid int64, status string) error {
	if _, err := db.PG().Exec(ctx,
		"UPDATE friendships SET status = $3 WHERE user_id = $1 AND friend_id = $2", uid, fid, status); err != nil {
		return err
	}
	_, err := db.PG().Exec(ctx,
		"UPDATE friendships SET status = $3 WHERE user_id = $1 AND friend_id = $2", fid, uid, status)
	return err
}

func (friendRepo) SetRemark(ctx context.Context, uid, fid int64, remark *string) error {
	var v any
	if remark != nil && *remark != "" {
		v = *remark
	}
	_, err := db.PG().Exec(ctx,
		"UPDATE friendships SET remark = $3 WHERE user_id = $1 AND friend_id = $2", uid, fid, v)
	return err
}

func (friendRepo) EnsureSingleConversation(ctx context.Context, convID string) error {
	_, err := db.PG().Exec(ctx,
		"INSERT INTO conversations (id, conv_type) VALUES ($1, 'single') ON CONFLICT (id) DO NOTHING", convID)
	return err
}
