package service

import (
	"context"

	"github.com/our-chat/biz/internal/repo"
)

// 类型别名:行结构定义在 repo(数据层),api 通过 service 引用,避免 api→repo 的跨层依赖。
type (
	UserConversation = repo.UserConversation
	Conversation     = repo.Conversation
)

// ChatService 会话/消息读取用例。
type ChatService struct {
	repo repo.ChatRepo
}

func NewChatService(r repo.ChatRepo) *ChatService { return &ChatService{repo: r} }

func (s *ChatService) UserConversations(ctx context.Context, userID string) ([]UserConversation, error) {
	return s.repo.UserConversations(ctx, userID)
}

func (s *ChatService) ConversationsByIDs(ctx context.Context, ids []string) ([]Conversation, error) {
	return s.repo.ConversationsByIDs(ctx, ids)
}

func (s *ChatService) Messages(ctx context.Context, convID string, beforeSeq int64, limit int) ([]Message, error) {
	return s.repo.Messages(ctx, convID, beforeSeq, limit)
}

func (s *ChatService) AllMessages(ctx context.Context, convID string) ([]Message, error) {
	return s.repo.AllMessages(ctx, convID)
}

// MessagesSince 增量同步拉取(seq 游标)。
func (s *ChatService) MessagesSince(ctx context.Context, convID string, sinceSeq int64, limit int) ([]Message, error) {
	return s.repo.MessagesSince(ctx, convID, sinceSeq, limit)
}

func (s *ChatService) LastMessages(ctx context.Context, convIDs []string) ([]Message, error) {
	return s.repo.LastMessages(ctx, convIDs)
}

// Touch 幂等更新会话活跃时间 + 建立「我的会话」关联。
func (s *ChatService) Touch(ctx context.Context, userID, convID string) error {
	if err := s.repo.TouchConversation(ctx, convID); err != nil {
		return err
	}
	return s.repo.AddUserConversation(ctx, userID, convID)
}
