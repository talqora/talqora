package api

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/disintegration/imaging"
	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/storage"
	"github.com/our-chat/biz/internal/store"
)

// mountUploadRoutes 挂载图片上传(/user/uploads/uploadImg)与高级上传(/api/upload/*)。
// 语义对齐 routes/upload.ts + routes/uploadAdvanced.ts(服务端中转上传,非 presigned 直传)。
func mountUploadRoutes(r *gin.Engine, cfg *config.Config) {
	storage.Init(cfg.S3)
	storage.InitMultipart(cfg.S3)
	img := r.Group("/user/uploads")
	img.POST("/uploadImg", AuthenticateToken(), handleUploadImg)

	adv := r.Group("/api/upload")
	adv.POST("/single", AuthenticateToken(), handleUploadSingle)
	adv.POST("/multiple", AuthenticateToken(), handleUploadMultiple)
	adv.POST("/check", AuthenticateToken(), handleUploadCheck)
	adv.POST("/chunk", AuthenticateToken(), handleUploadChunk)
	adv.POST("/merge", AuthenticateToken(), handleUploadMerge)
	adv.POST("/stream", AuthenticateToken(), handleUploadStream)
	adv.POST("/compress", AuthenticateToken(), handleUploadCompress)
	adv.GET("/resume/:fileId", AuthenticateToken(), handleUploadResume)
}

// readFormFile 读 multipart 文件(内存 buffer;multer memoryStorage 同语义)。
func readFormFile(c *gin.Context, field string) (data []byte, originalName, mimeType string, err error) {
	fh, err := c.FormFile(field)
	if err != nil {
		return nil, "", "", err
	}
	// multer 限制:单文件 100MB(超限报错 → Express error handler → 500)
	if fh.Size > 100*1024*1024 {
		return nil, "", "", fmt.Errorf("文件超过大小限制")
	}
	originalName = fh.Filename
	mimeType = fh.Header.Get("Content-Type")
	f, err := fh.Open()
	if err != nil {
		return nil, "", "", err
	}
	defer f.Close()
	data, err = io.ReadAll(f)
	return data, originalName, mimeType, err
}

// checkAllowedTypes multer fileFilter 等价:body.allowedTypes 逗号分隔过滤 mimetype。
func checkAllowedTypes(c *gin.Context, mimeType string) error {
	allowed := c.PostForm("allowedTypes")
	if allowed == "" {
		return nil
	}
	for _, t := range strings.Split(allowed, ",") {
		if strings.Contains(mimeType, t) {
			return nil
		}
	}
	return fmt.Errorf("文件类型不允许: %s", mimeType)
}

// persistBuffer 落库一个 buffer:MD5 秒传去重 → 未命中上传对象存储 + upsert UploadedFile。
func persistBuffer(c *gin.Context, buffer []byte, originalName, mimeType string) (url, md5Str string, size int, err error) {
	sum := md5.Sum(buffer)
	md5Str = hex.EncodeToString(sum[:])
	ctx := c.Request.Context()

	var objectKey string
	err = store.PG().QueryRow(ctx,
		"SELECT object_key FROM uploaded_files WHERE md5 = $1", md5Str).Scan(&objectKey)
	if err == nil {
		return storage.PublicURL(objectKey), md5Str, len(buffer), nil
	}
	if err != nil && !isNoRows(err) {
		return "", "", 0, err
	}

	key := storage.BuildObjectKey(originalName, md5Str)
	if err := storage.PutObject(ctx, key, buffer, mimeType); err != nil {
		return "", "", 0, err
	}
	// upsert 语义(并发重复上传幂等,uploadAdvanced.ts:34-38)
	if _, err := store.PG().Exec(ctx, `
		INSERT INTO uploaded_files (md5, object_key, size, mime_type) VALUES ($1, $2, $3, $4)
		ON CONFLICT (md5) DO NOTHING`, md5Str, key, len(buffer), mimeType); err != nil {
		return "", "", 0, err
	}
	return storage.PublicURL(key), md5Str, len(buffer), nil
}

// handleUploadImg 头像等图片上传(upload.ts:11-31)。
func handleUploadImg(c *gin.Context) {
	buffer, name, mime, err := readFormFile(c, "file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "没有上传文件"})
		return
	}
	if len(buffer) > 10*1024*1024 { // multerInstance 10MB 限制
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "文件超过大小限制"})
		return
	}
	key := storage.BuildObjectKey(name, "")
	if err := storage.PutObject(c.Request.Context(), key, buffer, mime); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"url": storage.PublicURL(key)}})
}

// handleUploadSingle 单文件上传(uploadAdvanced.ts:44-61)。
func handleUploadSingle(c *gin.Context) {
	buffer, name, mime, err := readFormFile(c, "file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "没有上传文件"})
		return
	}
	if err := checkAllowedTypes(c, mime); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	url, md5Str, size, err := persistBuffer(c, buffer, name, mime)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    gin.H{"url": url, "originalName": name, "size": size, "md5": md5Str},
	})
}

// handleUploadMultiple 多文件上传(最多 10 个,uploadAdvanced.ts:65-81)。
func handleUploadMultiple(c *gin.Context) {
	form, err := c.MultipartForm()
	if err != nil || len(form.File["files"]) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "没有上传文件"})
		return
	}
	files := form.File["files"]
	if len(files) > 10 {
		files = files[:10]
	}
	results := make([]gin.H, 0, len(files))
	for _, fh := range files {
		f, err := fh.Open()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
			return
		}
		data, err := io.ReadAll(f)
		f.Close()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
			return
		}
		url, md5Str, size, err := persistBuffer(c, data, fh.Filename, fh.Header.Get("Content-Type"))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
			return
		}
		results = append(results, gin.H{"url": url, "originalName": fh.Filename, "size": size, "md5": md5Str})
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": results})
}

// handleUploadCheck 秒传检查(uploadAdvanced.ts:85-102)。
func handleUploadCheck(c *gin.Context) {
	var body struct {
		FileMD5 string `json:"fileMD5"`
	}
	_ = c.ShouldBindJSON(&body)
	if body.FileMD5 == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "缺少文件MD5"})
		return
	}
	var objectKey string
	err := store.PG().QueryRow(c.Request.Context(),
		"SELECT object_key FROM uploaded_files WHERE md5 = $1", body.FileMD5).Scan(&objectKey)
	if err == nil {
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data":    gin.H{"exists": true, "url": storage.PublicURL(objectKey), "message": "文件已存在，秒传成功"},
		})
		return
	}
	if !isNoRows(err) {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    gin.H{"exists": false, "message": "文件不存在，需要上传"},
	})
}

// uploadSessionRow 分片会话行。
type uploadSessionRow struct {
	ObjectKey string
	UploadID  string
	FileName  string
}

// findUploadSession 查分片会话。
func findUploadSession(c *gin.Context, fileID string) (*uploadSessionRow, error) {
	var s uploadSessionRow
	err := store.PG().QueryRow(c.Request.Context(), `
		SELECT object_key, upload_id, file_name FROM upload_sessions WHERE file_id = $1`, fileID,
	).Scan(&s.ObjectKey, &s.UploadID, &s.FileName)
	if isNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// handleUploadChunk 分片上传(uploadAdvanced.ts:109-144):首片初始化 multipart 会话。
func handleUploadChunk(c *gin.Context) {
	fileID := c.Query("fileId")
	chunkIndex, err := strconv.Atoi(c.Query("chunkIndex"))
	fileName := c.PostForm("fileName")
	totalChunks := c.PostForm("totalChunks")

	buffer, _, mime, err := readFormFile(c, "chunk")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "没有上传分片"})
		return
	}
	if fileID == "" || err != nil || fileName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "缺少分片参数(fileId/chunkIndex/fileName)"})
		return
	}

	session, err := findUploadSession(c, fileID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	if session == nil {
		key := storage.BuildObjectKey(fileName, "")
		uploadID, err := storage.CreateMultipartUpload(c.Request.Context(), key, mime)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
			return
		}
		total, _ := strconv.Atoi(totalChunks)
		if _, err := store.PG().Exec(c.Request.Context(), `
			INSERT INTO upload_sessions (file_id, upload_id, object_key, file_name, mime_type, total_chunks)
			VALUES ($1, $2, $3, $4, $5, $6)`, fileID, uploadID, key, fileName, mime, total); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
			return
		}
		session = &uploadSessionRow{ObjectKey: key, UploadID: uploadID, FileName: fileName}
	}

	if _, err := storage.UploadPart(c.Request.Context(), session.ObjectKey, session.UploadID, chunkIndex+1, buffer); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    gin.H{"fileId": fileID, "chunkIndex": chunkIndex, "message": "分片上传成功"},
	})
}

// handleUploadMerge 合并分片(uploadAdvanced.ts:149-179)。
func handleUploadMerge(c *gin.Context) {
	var body struct {
		FileID      string `json:"fileId"`
		TotalChunks any    `json:"totalChunks"`
	}
	_ = c.ShouldBindJSON(&body)
	if body.FileID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "缺少必要参数"})
		return
	}
	session, err := findUploadSession(c, body.FileID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	if session == nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "message": "分片会话不存在(请重新上传)"})
		return
	}

	parts, err := storage.ListUploadedParts(c.Request.Context(), session.ObjectKey, session.UploadID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	expected := int(toFloat(body.TotalChunks))
	if expected > 0 && len(parts) != expected {
		c.JSON(http.StatusBadRequest, gin.H{
			"success": false,
			"message": fmt.Sprintf("分片不完整:已上传 %d/%d", len(parts), expected),
		})
		return
	}

	if err := storage.CompleteMultipartUpload(c.Request.Context(), session.ObjectKey, session.UploadID, parts); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	if _, err := store.PG().Exec(c.Request.Context(),
		"DELETE FROM upload_sessions WHERE file_id = $1", body.FileID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    gin.H{"url": storage.PublicURL(session.ObjectKey), "fileName": session.FileName, "message": "文件合并成功"},
	})
}

// handleUploadStream 流式上传(uploadAdvanced.ts:183-199)。
func handleUploadStream(c *gin.Context) {
	fileName := c.Query("fileName")
	if fileName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "缺少文件名"})
		return
	}
	key := storage.BuildObjectKey(fileName, "")
	ctx := c.Request.Context()
	if err := storage.PutObjectStream(ctx, key, c.Request.Body, c.Request.ContentLength, c.GetHeader("Content-Type")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	var size int64
	if info, err := storage.HeadObject(ctx, key); err == nil && info != nil {
		size = info.Size
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    gin.H{"url": storage.PublicURL(key), "fileName": fileName, "size": size, "message": "流式上传成功"},
	})
}

// handleUploadCompress 压缩上传(uploadAdvanced.ts:203-228):buffer → JPEG → persistBuffer。
func handleUploadCompress(c *gin.Context) {
	buffer, name, _, err := readFormFile(c, "file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "没有上传文件"})
		return
	}
	quality, _ := strconv.Atoi(c.PostForm("quality"))
	if quality <= 0 {
		quality = 80
	}
	img, err := imaging.Decode(readerFromBytes(buffer))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	var out strings.Builder
	_ = out
	buf := newBytesBuffer()
	if err := imaging.Encode(buf, img, imaging.JPEG, imaging.JPEGQuality(quality)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	compressed := buf.Bytes()

	url, md5Str, size, err := persistBuffer(c, compressed, "image.jpg", "image/jpeg")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	originalSize := len(buffer)
	ratio := "0.00%"
	if originalSize > 0 {
		ratio = fmt.Sprintf("%.2f%%", float64(originalSize-size)/float64(originalSize)*100)
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"url":              url,
			"originalName":     name,
			"size":             size,
			"originalSize":     originalSize,
			"compressionRatio": ratio,
			"md5":              md5Str,
		},
	})
}

// handleUploadResume 断点续传查询(uploadAdvanced.ts:232-245):返回 0-based 已传分片号。
func handleUploadResume(c *gin.Context) {
	fileID := c.Param("fileId")
	session, err := findUploadSession(c, fileID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	if session == nil {
		c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"uploadedChunks": []int{}}})
		return
	}
	parts, err := storage.ListUploadedParts(c.Request.Context(), session.ObjectKey, session.UploadID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": err.Error()})
		return
	}
	chunks := make([]int, 0, len(parts))
	for _, p := range parts {
		chunks = append(chunks, p.PartNumber-1)
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": gin.H{"uploadedChunks": chunks}})
}

var _ = pgx.ErrNoRows
