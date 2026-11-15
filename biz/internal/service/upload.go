package service

import (
	"context"

	"github.com/our-chat/biz/internal/repo"
)

var uploadRepo = repo.NewUploadRepo()

// ObjectKeyByMD5 秒传:按 md5 取已存在对象键,不存在返回 repo.ErrNotFound。
func ObjectKeyByMD5(ctx context.Context, md5 string) (string, error) {
	return uploadRepo.ObjectKeyByMD5(ctx, md5)
}

// SaveUploadedFile 记录已上传文件(幂等)。
func SaveUploadedFile(ctx context.Context, md5, key string, size int, mimeType string) error {
	return uploadRepo.SaveFile(ctx, md5, key, size, mimeType)
}

// UploadSession 查分片会话;不存在返回 (nil, repo.ErrNotFound)。
func UploadSession(ctx context.Context, fileID string) (*repo.UploadSession, error) {
	return uploadRepo.Session(ctx, fileID)
}

// SaveUploadSession 建分片会话。
func SaveUploadSession(ctx context.Context, fileID, uploadID, key, fileName, mimeType string, totalChunks int) error {
	return uploadRepo.SaveSession(ctx, fileID, uploadID, key, fileName, mimeType, totalChunks)
}

// DeleteUploadSession 合并完成后清理会话。
func DeleteUploadSession(ctx context.Context, fileID string) error {
	return uploadRepo.DeleteSession(ctx, fileID)
}
