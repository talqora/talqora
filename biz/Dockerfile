# 构建阶段:静态编译 Go 二进制(迁移文件 embed 进二进制)
FROM golang:1.22-alpine AS builder
WORKDIR /src
# 依赖源:默认官方;服务器本地 build 时由 compose 传 GOPROXY_URL=goproxy.cn(国内快)。
ARG GOPROXY_URL=https://proxy.golang.org,direct
ENV GOPROXY=$GOPROXY_URL
# 先拷依赖清单,利用层缓存
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO 关闭 → 纯静态二进制,可在精简镜像直接跑
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /biz ./cmd/biz

# 运行阶段:精简镜像,非 root
FROM alpine:3.20
RUN apk add --no-cache wget ca-certificates \
  && adduser -D -u 10001 app
COPY --from=builder /biz /usr/local/bin/biz
USER app
EXPOSE 3007 3008
