#!/usr/bin/env bash
# 补齐 26-9-16-grpc 期因 colima 失联缺失的场景:tp_r30 三轮 + 专项(S6/S7/扇出/HTTP)。
set -u
cd "$(dirname "$0")"
export OUT_SUBDIR=26-9-16-grpc

for r in 1 2 3; do
  echo "=== tp_r30 round $r ==="
  node ab-run.mjs gateway "tp_r30_gateway_r${r}" 100 30 20 25 || echo "!! tp_r30 r${r} 失败"
  sleep 5
done
ROUNDS=3 OUT_SUBDIR=26-9-16-grpc node -e '
  const fs = require("fs");
  const sub = process.env.OUT_SUBDIR;
  const rounds = [];
  for (let r = 1; r <= 3; r++) {
    const p = `../docs/监测设施/测试报告/${sub}/data/tp_r30_gateway_r${r}.json`;
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const h = j.harness || {};
    rounds.push({ r, j, score: h.rttMs?.p99 ?? NaN });
  }
  if (rounds.length) {
    rounds.sort((a, b) => a.score - b.score);
    const mid = rounds[Math.floor(rounds.length / 2)];
    fs.writeFileSync(`../docs/监测设施/测试报告/${sub}/data/tp_r30_gateway.json`, JSON.stringify(mid.j, null, 2));
    console.log(`== tp_r30 取中位轮 r${mid.r} (p99=${mid.score})`);
  }
'

bash run-gw-special.sh
echo "FILL DONE"
