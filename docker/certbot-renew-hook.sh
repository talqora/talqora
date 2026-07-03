#!/usr/bin/env bash
# Let's Encrypt 证书续期后的自动重载钩子。
#
# 由部署脚本(ci-deploy.sh)安装到宿主机 /etc/letsencrypt/renewal-hooks/deploy/ 下,
# certbot **每次续期成功后会自动运行该目录里的所有脚本**(无需改 certbot 命令/定时器)。
#
# 为什么需要:证书在宿主机 /etc/letsencrypt 续期,但容器是只读挂载、证书已加载进内存——
#   · nginx(web):内存里缓存旧证书 → 需热 reload。
#   · coturn:只在启动时读证书,无热加载 → 需重启(会短暂中断正在走 relay 的通话,
#     但续期约 60-90 天一次、重启秒级,可接受;如需零中断可后续改 SIGHUP 方案)。
#
# 幂等 + 容错:某个容器不在/坏配置时**跳过**,绝不让 certbot 续期因此失败(最后 exit 0)。
set -u

# nginx:先 nginx -t 校验,通过才热 reload(坏配置就跳过,保留运行中的旧配置)
if docker exec our-chat-web nginx -t >/dev/null 2>&1; then
  docker exec our-chat-web nginx -s reload >/dev/null 2>&1 \
    && echo "[cert-renew-hook] nginx reloaded" \
    || echo "[cert-renew-hook] nginx reload 失败,跳过"
else
  echo "[cert-renew-hook] nginx 不在/配置未通过校验,跳过 reload"
fi

# coturn:无热加载证书能力,直接重启以加载新证书
docker restart our-chat-coturn >/dev/null 2>&1 \
  && echo "[cert-renew-hook] coturn restarted" \
  || echo "[cert-renew-hook] coturn 不在,跳过 restart"

exit 0
