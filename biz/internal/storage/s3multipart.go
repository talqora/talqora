package storage

// 分片会话(S3 multipart)低层 API 封装。
//
// 选型偏离说明(报告记录):选型报告定稿 minio-go/v7,但其 v7.3.0 已把公开的
// NewMultipartUpload/UploadPart/ListObjectParts/CompleteMultipartUpload/AbortMultipartUpload
// 全部私有化(仅保留高层自动 multipart 的 PutObject),无法实现 Node 版的分片会话
// (断点续传/合并,uploadAdvanced.ts 契约)。故分片会话路径改用 aws-sdk-go-v2 的 S3
// 低层 API——与 Node 侧 @aws-sdk/client-s3 完全同源,协议/语义一致;其余对象操作
// (单文件/秒传/流式/图片)仍走 minio-go v7(见 s3.go)。

import (
	"bytes"
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/our-chat/biz/internal/config"
)

var awsS3 *s3.Client

// InitMultipart 建立 aws-sdk-go-v2 S3 客户端(与 minio 同 endpoint/凭证,path-style)。
func InitMultipart(cfg config.S3Config) {
	creds := credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, "")
	awsS3 = s3.New(s3.Options{
		Region:       cfg.Region,
		Credentials:  creds,
		BaseEndpoint: aws.String(cfg.Endpoint),
		UsePathStyle: cfg.ForcePathStyle,
	})
	_ = awsconfig.LoadDefaultConfig // 仅保留导入,客户端为手工构造
}

// CreateMultipartUpload 初始化分片上传,返回 uploadId(storage.ts:126-132 语义)。
func CreateMultipartUpload(ctx context.Context, key, contentType string) (string, error) {
	out, err := awsS3.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket:      aws.String(s3cfg.Bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", err
	}
	if out.UploadId == nil {
		return "", errMissingUploadID
	}
	return *out.UploadId, nil
}

// UploadPart 上传一个分片,返回 ETag(partNumber 从 1 开始,storage.ts:135-152 语义)。
func UploadPart(ctx context.Context, key, uploadID string, partNumber int, body []byte) (string, error) {
	out, err := awsS3.UploadPart(ctx, &s3.UploadPartInput{
		Bucket:     aws.String(s3cfg.Bucket),
		Key:        aws.String(key),
		UploadId:   aws.String(uploadID),
		PartNumber: aws.Int32(int32(partNumber)),
		Body:       bytes.NewReader(body),
	})
	if err != nil {
		return "", err
	}
	if out.ETag == nil {
		return "", errMissingETag
	}
	return *out.ETag, nil
}

// ListUploadedParts 查询已上传分片,按 partNumber 升序(storage.ts:155-180 语义,含分页)。
func ListUploadedParts(ctx context.Context, key, uploadID string) ([]Part, error) {
	parts := []Part{}
	var marker *string
	for {
		out, err := awsS3.ListParts(ctx, &s3.ListPartsInput{
			Bucket:           aws.String(s3cfg.Bucket),
			Key:              aws.String(key),
			UploadId:         aws.String(uploadID),
			PartNumberMarker: marker,
		})
		if err != nil {
			return nil, err
		}
		for _, p := range out.Parts {
			if p.PartNumber != nil && p.ETag != nil {
				parts = append(parts, Part{PartNumber: int(*p.PartNumber), ETag: *p.ETag})
			}
		}
		if out.IsTruncated == nil || !*out.IsTruncated {
			break
		}
		marker = out.NextPartNumberMarker
		if marker == nil {
			break
		}
	}
	// 升序(S3 默认按 partNumber 升序,显式排序保稳)
	sortParts(parts)
	return parts, nil
}

// CompleteMultipartUpload 合并分片(storage.ts:182-197 语义)。
func CompleteMultipartUpload(ctx context.Context, key, uploadID string, parts []Part) error {
	complete := make([]types.CompletedPart, 0, len(parts))
	for _, p := range parts {
		complete = append(complete, types.CompletedPart{
			PartNumber: aws.Int32(int32(p.PartNumber)),
			ETag:       aws.String(p.ETag),
		})
	}
	_, err := awsS3.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:          aws.String(s3cfg.Bucket),
		Key:             aws.String(key),
		UploadId:        aws.String(uploadID),
		MultipartUpload: &types.CompletedMultipartUpload{Parts: complete},
	})
	return err
}

// AbortMultipartUpload 终止分片上传(storage.ts:199-203 语义)。
func AbortMultipartUpload(ctx context.Context, key, uploadID string) error {
	_, err := awsS3.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket:   aws.String(s3cfg.Bucket),
		Key:      aws.String(key),
		UploadId: aws.String(uploadID),
	})
	return err
}

func sortParts(parts []Part) {
	for i := 1; i < len(parts); i++ {
		for j := i; j > 0 && parts[j].PartNumber < parts[j-1].PartNumber; j-- {
			parts[j], parts[j-1] = parts[j-1], parts[j]
		}
	}
}
