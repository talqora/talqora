package repo

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/our-chat/biz/internal/db"
)

// UploadSession 分片上传会话。
type UploadSession struct {
	ObjectKey string
	UploadID  string
	FileName  string
}

// UploadRepo 上传域数据访问(秒传查表 + 分片会话)。
type UploadRepo interface {
	ObjectKeyByMD5(ctx context.Context, md5 string) (string, error)
	SaveFile(ctx context.Context, md5, key string, size int, mimeType string) error
	Session(ctx context.Context, fileID string) (*UploadSession, error)
	SaveSession(ctx context.Context, fileID, uploadID, key, fileName, mimeType string, totalChunks int) error
	DeleteSession(ctx context.Context, fileID string) error
}

type uploadRepo struct{}

func NewUploadRepo() UploadRepo { return uploadRepo{} }

func (uploadRepo) ObjectKeyByMD5(ctx context.Context, md5 string) (string, error) {
	var key string
	err := db.RO().QueryRow(ctx, "SELECT object_key FROM uploaded_files WHERE md5 = $1", md5).Scan(&key)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return key, err
}

func (uploadRepo) SaveFile(ctx context.Context, md5, key string, size int, mimeType string) error {
	return Exec(ctx, `
		INSERT INTO uploaded_files (md5, object_key, size, mime_type) VALUES ($1, $2, $3, $4)
		ON CONFLICT (md5) DO NOTHING`, md5, key, size, mimeType)
}

func (uploadRepo) Session(ctx context.Context, fileID string) (*UploadSession, error) {
	var s UploadSession
	err := db.PG().QueryRow(ctx,
		"SELECT object_key, upload_id, file_name FROM upload_sessions WHERE file_id = $1", fileID).
		Scan(&s.ObjectKey, &s.UploadID, &s.FileName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (uploadRepo) SaveSession(ctx context.Context, fileID, uploadID, key, fileName, mimeType string, totalChunks int) error {
	return Exec(ctx, `
		INSERT INTO upload_sessions (file_id, upload_id, object_key, file_name, mime_type, total_chunks)
		VALUES ($1, $2, $3, $4, $5, $6)`, fileID, uploadID, key, fileName, mimeType, totalChunks)
}

func (uploadRepo) DeleteSession(ctx context.Context, fileID string) error {
	return Exec(ctx, "DELETE FROM upload_sessions WHERE file_id = $1", fileID)
}
