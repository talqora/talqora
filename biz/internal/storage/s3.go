// Package storage 是对象存储访问层(S3 兼容:MinIO/COS),语义对齐 server/src/storage/storage.ts。
// 服务端中转上传:收 buffer/流后 putObject/uploadPart(web 前端契约依赖 POST /api/upload/*,不做客户端直传)。
package storage

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/store"
)

var s3cfg config.S3Config

// Init 保存配置供对象键/publicUrl 使用(由 main 在 NewS3 后调用)。
func Init(cfg config.S3Config) {
	s3cfg = cfg
}

// PublicURL 对象键 → 公开访问 URL(bucket 公有读,storage.ts:70-72)。
func PublicURL(key string) string {
	return s3cfg.PublicBaseURL + "/" + key
}

// BuildObjectKey 生成对象键:uploads/{yyyymm}/{base}{ext}(storage.ts:78-82)。
// base 传 md5(秒传去重)或留空用 uuid。
func BuildObjectKey(originalName, base string) string {
	ext := strings.ToLower(filepath.Ext(originalName))
	yyyymm := time.Now().UTC().Format("200601")
	if base == "" {
		base = randomUUID()
	}
	return "uploads/" + yyyymm + "/" + base + ext
}

// PutObject 上传内存 buffer(storage.ts:84-88)。
func PutObject(ctx context.Context, key string, body []byte, contentType string) error {
	opts := minio.PutObjectOptions{ContentType: contentType}
	_, err := store.S3().PutObject(ctx, s3cfg.Bucket, key, bytes.NewReader(body), int64(len(body)), opts)
	return err
}

// PutObjectStream 流式直传(边收边传,storage.ts:91-101)。
func PutObjectStream(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	opts := minio.PutObjectOptions{ContentType: contentType}
	_, err := store.S3().PutObject(ctx, s3cfg.Bucket, key, body, size, opts)
	return err
}

// HeadObject 对象元信息,不存在返回 nil(storage.ts:113-122)。
func HeadObject(ctx context.Context, key string) (*minio.ObjectInfo, error) {
	info, err := store.S3().StatObject(ctx, s3cfg.Bucket, key, minio.StatObjectOptions{})
	if err != nil {
		if minio.ToErrorResponse(err).Code == "NoSuchKey" {
			return nil, nil
		}
		return nil, err
	}
	return &info, nil
}

// Part 已上传分片(storage.ts:155-180 的 {partNumber, etag})。
type Part struct {
	PartNumber int
	ETag       string
}

// 分片会话(CreateMultipartUpload/UploadPart/ListUploadedParts/CompleteMultipartUpload/
// AbortMultipartUpload)在 s3multipart.go:minio-go v7 移除了公开手控分片 API,
// 改用 aws-sdk-go-v2(与 Node @aws-sdk 同源),偏离理由见该文件头注释。

var (
	errMissingUploadID = fmt.Errorf("CreateMultipartUpload 未返回 UploadId")
	errMissingETag     = fmt.Errorf("uploadPart 未返回 ETag")
)

func randomUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b)
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}
