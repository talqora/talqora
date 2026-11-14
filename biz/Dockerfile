# 构建阶段:静态编译 Go 二进制(迁移文件 embed 进二进制)
# 构建镜像的 Go 版本必须 ≥ go.mod 里的 go 指令(当前 1.26.5)。
# Go 1.21 起官方镜像默认 GOTOOLCHAIN=local,不会自动下载更高版本工具链,
# 版本不匹配会直接构建失败。改 go.mod 时同步改这里。
FROM golang:1.26-alpine AS builder
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
# 没有 ENTRYPOINT 时容器会执行基础镜像的默认 /bin/sh,非交互环境下立即退出,
# 表现为「镜像能构建、容器起不来」——这类问题只有真的 run 一次才能发现。
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3007/health || exit 1
ENTRYPOINT ["/usr/local/bin/biz"]
