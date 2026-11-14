#!/bin/sh
# LocalStack ready 钩子:创建业务桶并设为匿名可读。
# 原 MinIO 方案用 `mc mb` + `mc anonymous set download`,这里用等价的 awslocal 实现,
# 保证 biz 的 PublicURL(S3_PUBLIC_BASE_URL/key)能直接下载。
set -eu

BUCKET="${S3_BUCKET:-our-chat}"
REGION="${S3_REGION:-us-east-1}"

echo "[init-s3] waiting for s3 ..."
until awslocal s3api list-buckets >/dev/null 2>&1; do sleep 1; done

awslocal s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1 || true

# 匿名只读:头像/图片走公开 URL(与原 MinIO `anonymous set download` 语义一致)。
awslocal s3api put-bucket-policy --bucket "$BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Effect\": \"Allow\",
    \"Principal\": \"*\",
    \"Action\": \"s3:GetObject\",
    \"Resource\": \"arn:aws:s3:::${BUCKET}/*\"
  }]
}"

echo "[init-s3] bucket ready: ${BUCKET}"
