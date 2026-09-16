#!/usr/bin/env bash
# 补 tp_r30 的 r2/r3(过载场景,放最后;跑完中间件可能失联,属已知环境现象)。
set -u
cd "$(dirname "$0")"
export OUT_SUBDIR=26-9-16-grpc

for r in 2 3; do
  echo "=== tp_r30 round $r ==="
  node ab-run.mjs gateway "tp_r30_gateway_r${r}" 100 30 20 25 || echo "!! tp_r30 r${r} 失败"
  sleep 5
done
# 三轮取中位(按 rttMs.p99;无效轮被过滤后若只剩有效轮则直接用)
node -e '
  const fs = require("fs");
  const sub = "26-9-16-grpc";
  const rounds = [];
  for (let r = 1; r <= 3; r++) {
    const p = `../docs/监测设施/测试报告/${sub}/data/tp_r30_gateway_r${r}.json`;
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const h = j.harness || {};
    const score = h.rttMs?.p99;
    if (score == null || Number.isNaN(score)) continue; // 过滤 login_failed 等无效轮
    rounds.push({ r, j, score });
  }
  if (!rounds.length) { console.error("tp_r30 无有效轮次"); process.exit(1); }
  rounds.sort((a, b) => a.score - b.score);
  const mid = rounds[Math.floor(rounds.length / 2)];
  fs.writeFileSync(`../docs/监测设施/测试报告/${sub}/data/tp_r30_gateway.json`, JSON.stringify(mid.j, null, 2));
  console.log(`== tp_r30 有效轮 ${rounds.map(x=>"r"+x.r+"("+x.score+")").join(" ")} 取中位 r${mid.r} (p99=${mid.score})`);
'
echo "R30 FILL DONE"
