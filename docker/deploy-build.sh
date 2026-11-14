#!/usr/bin/env bash
# 实际的本地构建 + 滚动重启。由 ci-deploy.sh 以 setsid 脱离 SSH 会话后台调用。
# 为何脱离会话:runner(海外)→服务器(国内)的 SSH 在几分钟长构建期间(尤其拉基础镜像时控制通道静默)
# 易被 GFW 重置;build 一旦脱离会话,即便 SSH 断了也能跑完(实测会话断后 build 仍在服务器续跑)。
# 依赖 WEB_PUBLIC_ORIGIN(web 构建期 build-arg)从环境继承。--progress plain 让日志逐行可读(写入 deploy.log)。
set -euo pipefail
cd "$(dirname "$0")"
docker compose -f docker-compose.prod.yml build --progress plain
docker compose -f docker-compose.prod.yml up -d --remove-orphans

# 挂载的 nginx 配置(nginx.conf / conf.d/*.conf)改动不会被 up 自动加载:web 镜像没变则容器不重建,
# 旧配置仍驻留在内存。这里显式校验 + 热 reload,让改代理/路由无需重建即时生效。
# 校验失败必须让部署失败:吞掉 nginx -t 的错误只会得到「脚本报成功、线上 502」。
# 容器刚重建时 exec 可能短暂不可用,最多重试 10s;仍失败则视为部署失败。
nginx_ok=0
for _ in $(seq 1 10); do
  if docker exec our-chat-web nginx -t >/dev/null 2>&1; then nginx_ok=1; break; fi
  sleep 1
done
if [ "$nginx_ok" -ne 1 ]; then
  echo "::error::nginx 配置校验失败(nginx -t),部署中止"
  docker exec our-chat-web nginx -t || true
  exit 1
fi
docker exec our-chat-web nginx -s reload
echo "nginx reloaded(配置校验通过)"

docker image prune -f
