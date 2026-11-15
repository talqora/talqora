package service

import (
	"context"
	"fmt"

	"github.com/our-chat/biz/internal/repo"
)

// FriendService 好友域用例:授权校验、编排 repo、发事件。不含 HTTP 概念。
type FriendService struct {
	repo repo.FriendRepo
}

func NewFriendService(r repo.FriendRepo) *FriendService {
	return &FriendService{repo: r}
}

// SingleConvID 单聊会话 id 约定:single_<小id>_<大id>。
func SingleConvID(a, b int64) string {
	if a > b {
		a, b = b, a
	}
	return fmt.Sprintf("single_%d_%d", a, b)
}

func (s *FriendService) ListFriends(ctx context.Context, uid int64, p repo.Page) (repo.Result[repo.Friend], error) {
	return s.repo.ListFriends(ctx, uid, p)
}

func (s *FriendService) ListReqs(ctx context.Context, uid int64, p repo.Page) (repo.Result[repo.FriendReq], error) {
	return s.repo.ListReqs(ctx, uid, p)
}

// Search 按关键词查用户并判断与我的关系(已是好友 / 陌生人)。
func (s *FriendService) Search(ctx context.Context, me int64, keyword string) (repo.UserCard, bool, error) {
	u, err := s.repo.SearchUser(ctx, keyword)
	if err != nil {
		return repo.UserCard{}, false, err
	}
	friend, err := s.repo.HasRelation(ctx, me, u.ID)
	if err != nil {
		return repo.UserCard{}, false, err
	}
	return u, friend, nil
}

// AddFriend 发起好友请求:双向落库 + 向接收方推送 receiveFriendReq(best-effort)。
func (s *FriendService) AddFriend(ctx context.Context, uid, fid int64) error {
	if err := s.repo.AddRequest(ctx, uid, fid); err != nil {
		return err
	}
	if me, err := s.repo.UserBrief(ctx, uid); err == nil {
		EmitToUser(ctx, fid, "receiveFriendReq", map[string]any{
			"id":        0,
			"userId":    fid,
			"friendId":  uid,
			"status":    "pending",
			"remark":    nil,
			"createdAt": nowRFC3339(),
			"updatedAt": nowRFC3339(),
			"username":  me.Username,
			"avatar":    me.Avatar,
		})
	}
	return nil
}

// Reply 同意/拒绝好友请求:双向改状态;同意时建单聊会话并通知双方。
func (s *FriendService) Reply(ctx context.Context, uid, fid int64, status string) error {
	if status == "accepted" {
		if err := s.repo.EnsureSingleConversation(ctx, SingleConvID(uid, fid)); err != nil {
			return err
		}
	}
	if err := s.repo.ReplyRequest(ctx, uid, fid, status); err != nil {
		return err
	}
	if status != "accepted" {
		EmitToUser(ctx, fid, "friendListChanged", map[string]any{"peerId": uid})
		return nil
	}
	EmitToUser(ctx, uid, "friendListChanged", map[string]any{"peerId": fid})
	EmitToUser(ctx, fid, "friendListChanged", map[string]any{"peerId": uid})

	// 微信式自动招呼语(双方各一条,best-effort,失败不影响主流程)
	convID := SingleConvID(uid, fid)
	name := ""
	if u, err := s.repo.UserBrief(ctx, fid); err == nil {
		name = u.Username
	}
	for _, m := range []struct {
		sender  int64
		content string
	}{
		{fid, "我是" + name},
		{uid, "我通过了你的朋友验证请求，现在我们可以开始聊天了"},
	} {
		if _, err := PersistAndBroadcastMessage(ctx, PersistMessageInput{
			ConversationID: convID, SenderID: m.sender, ClientMsgID: newUUID(), Content: m.content, Type: "text",
		}); err != nil {
			LogWarn("好友通过后自动消息失败", err)
		}
	}
	return nil
}

// SetRemark 设置备注(空串表示清空)。
func (s *FriendService) SetRemark(ctx context.Context, uid, fid int64, remark *string) error {
	return s.repo.SetRemark(ctx, uid, fid, remark)
}
