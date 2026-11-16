package repo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/our-chat/biz/internal/db"
)

// Group 群基本信息。
type Group struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Avatar      *string `json:"avatar"`
	OwnerID     int64   `json:"ownerId"`
	MemberCount int     `json:"memberCount"`
}

// GroupMember 群成员(带用户资料,便于前端直接渲染)。
type GroupMember struct {
	UserID   int64   `json:"userId"`
	Username string  `json:"username"`
	Nickname *string `json:"nickname"` // 我在本群的昵称(为空则用 username)
	Avatar   *string `json:"avatar"`
	Role     string  `json:"role"`
}

// GroupRepo 群聊数据访问:建群需要跨四张表的一次事务,故收在 repo 内。
type GroupRepo interface {
	Create(ctx context.Context, name string, ownerID int64, memberIDs []int64) (int64, error)
	Info(ctx context.Context, groupID int64) (Group, []GroupMember, error)
	Rename(ctx context.Context, groupID int64, name string) error
	AddMembers(ctx context.Context, groupID int64, memberIDs []int64) error
	SetMemberNickname(ctx context.Context, groupID, userID int64, nickname *string) error
	IsMember(ctx context.Context, groupID, userID int64) (bool, error)
}

type groupRepo struct{}

func NewGroupRepo() GroupRepo { return groupRepo{} }

// Create 建群:user_groups → group_members → conversations → user_conversations,单事务。
func (groupRepo) Create(ctx context.Context, name string, ownerID int64, memberIDs []int64) (int64, error) {
	tx, err := db.PG().Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var groupID int64
	if err := tx.QueryRow(ctx,
		"INSERT INTO user_groups (name, owner_id) VALUES ($1, $2) RETURNING id", name, ownerID).
		Scan(&groupID); err != nil {
		return 0, err
	}
	// owner 也在成员表里(role=owner),与微信一致
	if _, err := tx.Exec(ctx,
		"INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')", groupID, ownerID); err != nil {
		return 0, err
	}
	for _, uid := range memberIDs {
		if uid == ownerID {
			continue
		}
		if _, err := tx.Exec(ctx,
			"INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)", groupID, uid); err != nil {
			return 0, err
		}
	}
	convID := GroupConvID(groupID)
	if _, err := tx.Exec(ctx,
		"INSERT INTO conversations (id, conv_type, title) VALUES ($1, 'group', $2) ON CONFLICT (id) DO NOTHING",
		convID, name); err != nil {
		return 0, err
	}
	for _, uid := range append([]int64{ownerID}, memberIDs...) {
		if _, err := tx.Exec(ctx,
			"INSERT INTO user_conversations (user_id, conversation_id) VALUES ($1, $2) ON CONFLICT (user_id, conversation_id) DO NOTHING",
			uid, convID); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return groupID, nil
}

// GroupConvID 会话 id 约定:group_<id>。
func GroupConvID(groupID int64) string { return "group_" + itoa64(groupID) }

func (groupRepo) Info(ctx context.Context, groupID int64) (Group, []GroupMember, error) {
	var g Group
	err := db.RO().QueryRow(ctx,
		"SELECT id, name, avatar, owner_id FROM user_groups WHERE id = $1", groupID).
		Scan(&g.ID, &g.Name, &g.Avatar, &g.OwnerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Group{}, nil, ErrNotFound
	}
	if err != nil {
		return Group{}, nil, err
	}
	rows, err := db.RO().Query(ctx, `
		SELECT m.user_id, u.username, m.nickname, u.avatar, m.role::text
		FROM group_members m JOIN users u ON u.id = m.user_id
		WHERE m.group_id = $1 ORDER BY m.joined_at ASC`, groupID)
	if err != nil {
		return Group{}, nil, err
	}
	defer rows.Close()
	members := []GroupMember{}
	for rows.Next() {
		var m GroupMember
		if err := rows.Scan(&m.UserID, &m.Username, &m.Nickname, &m.Avatar, &m.Role); err != nil {
			return Group{}, nil, err
		}
		members = append(members, m)
	}
	g.MemberCount = len(members)
	return g, members, rows.Err()
}

// Rename 群名是"一名多处":user_groups.name 与 conversations.title 必须同事务更新,
// 否则会话列表读 conversations.title 会一直是旧名(前端刷新后尤其明显)。
func (groupRepo) Rename(ctx context.Context, groupID int64, name string) error {
	tx, err := db.PG().Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		"UPDATE user_groups SET name = $2, updated_at = now() WHERE id = $1", groupID, name); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		"UPDATE conversations SET title = $2, updated_at = now() WHERE id = $1", GroupConvID(groupID), name); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (groupRepo) AddMembers(ctx context.Context, groupID int64, memberIDs []int64) error {
	convID := GroupConvID(groupID)
	for _, uid := range memberIDs {
		if _, err := db.PG().Exec(ctx,
			"INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			groupID, uid); err != nil {
			return err
		}
		if _, err := db.PG().Exec(ctx,
			"INSERT INTO user_conversations (user_id, conversation_id) VALUES ($1, $2) ON CONFLICT (user_id, conversation_id) DO NOTHING",
			uid, convID); err != nil {
			return err
		}
	}
	return nil
}

// SetMemberNickname 设置「我在本群的昵称」(空串表示清空,回落到 username)。
func (groupRepo) SetMemberNickname(ctx context.Context, groupID, userID int64, nickname *string) error {
	var v any
	if nickname != nil && *nickname != "" {
		v = *nickname
	}
	return Exec(ctx,
		"UPDATE group_members SET nickname = $3 WHERE group_id = $1 AND user_id = $2", groupID, userID, v)
}

func (groupRepo) IsMember(ctx context.Context, groupID, userID int64) (bool, error) {
	var one int64
	err := db.RO().QueryRow(ctx,
		"SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2", groupID, userID).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func itoa64(v int64) string { return Sprintf("%d", v) }
