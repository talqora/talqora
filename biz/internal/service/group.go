package service

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/our-chat/biz/internal/repo"
)

// 群聊用例错误
var (
	ErrForbidden    = errors.New("forbidden")
	ErrGroupTooMany = errors.New("too many members")
	ErrGroupEmpty   = errors.New("no members")
)

// GroupService 群聊用例:建群、资料、改名、加人。
type GroupService struct {
	repo repo.GroupRepo
}

func NewGroupService(r repo.GroupRepo) *GroupService { return &GroupService{repo: r} }

const groupMaxMembers = 500

// CreateGroup 建群:成员去重、剔除自己、限制上限;群名空则「群聊(N)」。
func (s *GroupService) CreateGroup(ctx context.Context, ownerID int64, memberIDs []int64, name string) (int64, string, error) {
	seen := map[int64]bool{ownerID: true}
	ids := make([]int64, 0, len(memberIDs))
	for _, uid := range memberIDs {
		if uid <= 0 || seen[uid] {
			continue
		}
		seen[uid] = true
		ids = append(ids, uid)
	}
	if len(ids) == 0 {
		return 0, "", ErrGroupEmpty
	}
	if len(ids)+1 > groupMaxMembers {
		return 0, "", ErrGroupTooMany
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "群聊"
	}
	gid, err := s.repo.Create(ctx, name, ownerID, ids)
	if err != nil {
		return 0, "", err
	}
	convID := repo.GroupConvID(gid)
	for _, uid := range append([]int64{ownerID}, ids...) {
		EmitToUser(ctx, uid, "groupCreated", map[string]any{"groupId": gid, "conversationId": convID, "name": name})
	}
	return gid, convID, nil
}

// Info 群资料:非成员不可见(与微信一致)。
func (s *GroupService) Info(ctx context.Context, callerID, groupID int64) (repo.Group, []repo.GroupMember, error) {
	ok, err := s.repo.IsMember(ctx, groupID, callerID)
	if err != nil {
		return repo.Group{}, nil, err
	}
	if !ok {
		return repo.Group{}, nil, ErrForbidden
	}
	return s.repo.Info(ctx, groupID)
}

// Rename 仅群主可改群名。
func (s *GroupService) Rename(ctx context.Context, callerID, groupID int64, name string) error {
	g, _, err := s.repo.Info(ctx, groupID)
	if err != nil {
		return err
	}
	if g.OwnerID != callerID {
		return ErrForbidden
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.New("empty name")
	}
	if err := s.repo.Rename(ctx, groupID, name); err != nil {
		return err
	}
	// 通知在线成员刷新(客户端收到后重新拉群资料/会话)
	if _, members, err := s.repo.Info(ctx, groupID); err == nil {
		for _, m := range members {
			EmitToUser(ctx, m.UserID, "groupRenamed", map[string]any{
				"groupId": groupID, "conversationId": repo.GroupConvID(groupID), "name": name,
			})
		}
	}
	return nil
}

// AddMembers 仅群主可加人,且不超过上限。
func (s *GroupService) AddMembers(ctx context.Context, callerID, groupID int64, ids []int64) error {
	g, _, err := s.repo.Info(ctx, groupID)
	if err != nil {
		return err
	}
	if g.OwnerID != callerID {
		return ErrForbidden
	}
	if g.MemberCount+len(ids) > groupMaxMembers {
		return ErrGroupTooMany
	}
	return s.repo.AddMembers(ctx, groupID, ids)
}

var groupRepo = repo.NewGroupRepo()

// ErrNotGroupMember 非群成员不得向群发消息。
var ErrNotGroupMember = errors.New("not group member")

// ParseGroupConvID 解析 group_<id>,非群会话返回 ok=false。
func ParseGroupConvID(convID string) (int64, bool) {
	if !strings.HasPrefix(convID, "group_") {
		return 0, false
	}
	id, err := strconv.ParseInt(strings.TrimPrefix(convID, "group_"), 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

// SetMyNickname 设置「我在本群的昵称」:必须是群成员,长度 ≤ 32,空串表示清空。
func (s *GroupService) SetMyNickname(ctx context.Context, userID, groupID int64, nickname string) error {
	ok, err := s.repo.IsMember(ctx, groupID, userID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrForbidden
	}
	nickname = strings.TrimSpace(nickname)
	if len([]rune(nickname)) > 32 {
		return errors.New("nickname too long")
	}
	var v *string
	if nickname != "" {
		v = &nickname
	}
	return s.repo.SetMemberNickname(ctx, groupID, userID, v)
}
