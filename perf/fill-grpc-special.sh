#!/usr/bin/env bash
# 补齐 26-9-16-grpc 专项场景(colima 恢复后重跑;tp_r30 过载场景放最后避免中途打挂中间件)。
set -u
cd "$(dirname "$0")"
export OUT_SUBDIR=26-9-16-grpc

# 先确认业务层已恢复(登录探活)
for i in $(seq 1 30); do
  if node -e 'fetch("http://localhost:3007/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"bench_user_1",password:"bench_pw_123456"})}).then(r=>r.json()).then(j=>{if(j?.success){console.log("OK");process.exit(0)}process.exit(1)}).catch(()=>process.exit(1))'; then
    echo "业务层已恢复"
    break
  fi
  echo "等待业务层恢复($i/30)..."
  sleep 5
done

# 专项场景(均为轻负载,不含 tp 过载)
bash run-gw-special.sh

echo "SPECIAL FILL DONE"
