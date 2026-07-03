#!/usr/bin/env bash
# CI(ssh-action)在服务器执行的部署编排:生成 .env/私钥 → 后台(脱离 SSH 会话)构建并 up → 轮询结果。
#
# 为何后台 + 轮询:runner(海外)→服务器(国内)的 SSH 在几分钟长构建期间易被 GFW 重置(此前实测部署在第 8s
#   就掉线、但 build 其实在服务器孤儿续跑)。这里把 build+up 用 setsid 脱离 SSH 会话(断连也跑完),
#   再轮询结果文件 deploy.rc;轮询期每 10s tail 一次 deploy.log,既给可见进度,也让 SSH 通道保持有流量、
#   降低空闲被重置的概率。会话即便仍被重置,build 也不丢(只是这步显示失败)。
#
# 机密由 ssh-action 经 envs 注入到本脚本环境(不硬编码)。须在 compose 所在的 docker/ 目录下执行。
set -euo pipefail
cd "$(dirname "$0")"

# keys: OAuth 私钥; certbot-www: HTTPS 证书续期的 webroot 挑战目录
mkdir -p keys certbot-www
# 容器内 server 以非 root 用户(app,uid 10001)运行,需能"穿过"keys 目录读私钥;
# 目录若是 700(受限 umask 下 mkdir 默认),other 无 x → 即便私钥文件 644 也会 EACCES。显式给目录 o+rx。
chmod 755 keys

# 跨项目共享网络（与 agent-server 互通）：compose 以 external 引用，必须先存在（幂等）
docker network inspect oc-shared >/dev/null 2>&1 || docker network create oc-shared

# —— 写 OAuth 生产私钥（base64 secret 解码）——
# 容器内 server 以非 root 用户(app,uid 10001)运行;私钥需对其可读,否则启动读 key 报 EACCES。
# 单租户服务器 + :ro 挂载,644 可接受。
printf '%s' "${OAUTH_PRIVATE_KEY_B64}" | base64 -d > keys/oauth-private-prod.pem
chmod 644 keys/oauth-private-prod.pem

# —— 生成 .env（仅 ②③；①通用默认在 compose）。CLIENT_ORIGINS/OAUTH_* 由 WEB_PUBLIC_ORIGIN 派生，三处天然一致 ——
{
  echo "POSTGRES_USER=${POSTGRES_USER:-postgres}"
  echo "POSTGRES_DB=${POSTGRES_DB:-our_chat}"
  echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
  echo "JWT_SECRET=${JWT_SECRET}"
  echo "GATEWAY_INTERNAL_TOKEN=${GATEWAY_INTERNAL_TOKEN}"
  echo "OAUTH_ACTIVE_KID=${OAUTH_ACTIVE_KID}"
  echo "CLIENT_ORIGINS=${WEB_PUBLIC_ORIGIN}"
  echo "OAUTH_ISSUER_BASE_URL=${WEB_PUBLIC_ORIGIN}"
  echo "OAUTH_WEB_REDIRECT_URI=${WEB_PUBLIC_ORIGIN}/oauth/callback"
  echo "S3_ENDPOINT=${S3_ENDPOINT}"
  echo "S3_REGION=${S3_REGION}"
  echo "S3_BUCKET=${S3_BUCKET}"
  echo "S3_PUBLIC_BASE_URL=${S3_PUBLIC_BASE_URL}"
  echo "S3_ACCESS_KEY=${S3_ACCESS_KEY}"
  echo "S3_SECRET_KEY=${S3_SECRET_KEY}"
  # WebRTC TURN(coturn):server 用 TURN_SECRET/TURN_HOST 生成短期凭据;coturn 用 TURN_SECRET/TURN_EXTERNAL_IP。
  # TURN_HOST 由 WEB_PUBLIC_ORIGIN 剥掉协议/端口/路径得到(如 https://tujiang.tech → tujiang.tech)。
  echo "TURN_SECRET=${TURN_SECRET:-}"
  echo "TURN_HOST=$(printf '%s' "${WEB_PUBLIC_ORIGIN}" | sed -E 's#^[a-z]+://##; s#[:/].*$##')"
  echo "TURN_EXTERNAL_IP=${TURN_EXTERNAL_IP:-}"
  # coturn 用 host 网络会把 docker 网桥/回环也当中继地址,必须锁到真实私网网卡(默认路由源地址),
  # 否则中继落在 172.x → 对外不可达、通话打不通。取默认路由的 src IP。
  echo "TURN_LISTENING_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}')"
} > .env
chmod 600 .env

# —— 安装 Let's Encrypt 续期钩子:证书续期后自动 reload nginx + restart coturn(否则容器仍用旧证书)——
# certbot 在宿主机续期,容器只读挂载;钩子放进 renewal-hooks/deploy/,续期成功后 certbot 自动运行。
# 需免密 sudo 写 /etc/letsencrypt;没有则告警跳过(续期后需手动重载),不阻断部署。
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n install -D -m 0755 ./certbot-renew-hook.sh /etc/letsencrypt/renewal-hooks/deploy/our-chat-reload.sh \
    && echo "certbot 续期钩子已安装" \
    || echo "::warning::certbot 续期钩子安装失败;证书续期后需手动 nginx reload + coturn restart"
else
  echo "::warning::无免密 sudo,未安装 certbot 续期钩子;证书续期后需手动 nginx reload + coturn restart"
fi

# web 镜像构建期需 WEB_PUBLIC_ORIGIN(compose build-arg 从 shell env 取);导出供后台 build 继承。
export WEB_PUBLIC_ORIGIN

# —— 后台(脱离 SSH 会话)跑 build+up;结果码落 deploy.rc ——
rm -f deploy.rc deploy.log
setsid bash -c 'bash deploy-build.sh >deploy.log 2>&1; echo $? >deploy.rc' </dev/null >/dev/null 2>&1 &
echo "build+up 已后台启动(脱离 SSH 会话,断连也会跑完);轮询结果中…"

rc=""
# 180 * 10s = 30min 上限(基础镜像/依赖层已缓存时通常几分钟内完成)
for _ in $(seq 1 180); do
  if [ -f deploy.rc ]; then rc="$(cat deploy.rc)"; break; fi
  sleep 10
  tail -n 3 deploy.log 2>/dev/null || true
done

echo "===== 部署日志末尾 ====="
tail -n 60 deploy.log 2>/dev/null || true
docker compose -f docker-compose.prod.yml ps || true

if [ "${rc}" = "0" ]; then
  echo "✅ 部署完成"
else
  echo "::error::部署未成功(rc=${rc:-TIMEOUT});见上方日志"
  exit 1
fi
