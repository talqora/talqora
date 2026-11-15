package service

import (
	"context"
	"errors"

	"github.com/our-chat/biz/internal/repo"
)

// ErrNoFields 表示请求里没有可更新的白名单字段。
var ErrNoFields = errors.New("no updatable fields")

var userRepo = repo.NewUserRepo()

// CreateUser 落库新用户(密码已由调用方哈希)。
func CreateUser(ctx context.Context, in repo.NewUser) (repo.CreatedUser, error) {
	return userRepo.Create(ctx, in)
}

// UserExists 判断用户名/邮箱/手机号是否已被占用(col 必须在白名单内)。
func UserExists(ctx context.Context, col, val string) (bool, error) {
	return userRepo.ExistsBy(ctx, col, val)
}

// UpdateUserProfile 按白名单更新资料;一个字段都没命中则报 ErrNoFields。
func UpdateUserProfile(ctx context.Context, id int64, body map[string]any) error {
	fields := make(map[string]any, len(body))
	for k, v := range body {
		if k == "id" {
			continue
		}
		// 兼容驼峰入参(<-> 下划线列名)
		if k == "lastSeen" {
			k = "last_seen"
		}
		fields[k] = v
	}
	if len(fields) == 0 {
		return ErrNoFields
	}
	// 由 repo 的白名单过滤;若全部非法,等价于无字段可更新
	if err := userRepo.UpdateFields(ctx, id, fields); err != nil {
		return err
	}
	return nil
}
