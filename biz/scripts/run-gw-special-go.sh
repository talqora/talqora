#!/usr/bin/env bash
# Go 业务层专项场景:S6 爬坡 / S7 惊群 ×3 / 群扇出 ×3 / HTTP API 层。
# 数据落 docs/监测设施/测试报告/<OUT_SUBDIR>/data/(node 工具读 OUT_SUBDIR env,必须 export)。
set -u
cd "$(dirname "$0")/../../perf"
export OUT_SUBDIR="${OUT_SUBDIR:-26-9-18}"
DATA_DIR="../docs/监测设施/测试报告/${OUT_SUBDIR}/data"

echo "=== S6 连接爬坡:START=2000 STEP=2000 MAX=10000 HOLD_MS=5000 ==="
env START=2000 STEP=2000 MAX=10000 HOLD_MS=5000 node gw-ramp-probe.mjs || echo "!! s6 ramp 失败"

echo "=== S7 惊群重连 ×3 ==="
for r in 1 2 3; do
  echo "--- s7 round $r ---"
  node gw-storm-reconnect.mjs 300 50 || echo "!! s7 round $r 失败"
  cp "$DATA_DIR/s7_storm_gateway.json" "$DATA_DIR/s7_storm_gateway_r${r}.json" 2>/dev/null
  sleep 5
done
OUT_SUBDIR="$OUT_SUBDIR" node -e '
  const fs = require("fs");
  const sub = process.env.OUT_SUBDIR || "26-9-16-gobiz";
  const key = "s7_storm_gateway";
  const rounds = [];
  for (let r = 1; r <= 3; r++) {
    const p = `../docs/监测设施/测试报告/${sub}/data/${key}_r${r}.json`;
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    rounds.push({ r, j, score: j.stormReconnect?.p99 ?? NaN });
  }
  if (rounds.length) {
    rounds.sort((a, b) => a.score - b.score);
    const mid = rounds[Math.floor(rounds.length / 2)];
    fs.writeFileSync(`../docs/监测设施/测试报告/${sub}/data/${key}.json`, JSON.stringify(mid.j, null, 2));
    console.log(`== [s7] 取中位轮 r${mid.r} (p99=${mid.score})`);
  }
'

echo "=== 群扇出 ×3(100 成员,1 人发 20 条,GROUP_ID=9000002)==="
for r in 1 2 3; do
  echo "--- fanout round $r ---"
  node gw-fanout-bench.mjs 100 20 9000002 || echo "!! fanout round $r 失败"
  cp "$DATA_DIR/fanout_bench_gateway.json" "$DATA_DIR/fanout_bench_gateway_r${r}.json" 2>/dev/null
  sleep 5
done
OUT_SUBDIR="$OUT_SUBDIR" node -e '
  const fs = require("fs");
  const sub = process.env.OUT_SUBDIR || "26-9-16-gobiz";
  const key = "fanout_bench_gateway";
  const rounds = [];
  for (let r = 1; r <= 3; r++) {
    const p = `../docs/监测设施/测试报告/${sub}/data/${key}_r${r}.json`;
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    rounds.push({ r, j, score: j.fanoutSpanMs?.p99 ?? NaN });
  }
  if (rounds.length) {
    rounds.sort((a, b) => a.score - b.score);
    const mid = rounds[Math.floor(rounds.length / 2)];
    fs.writeFileSync(`../docs/监测设施/测试报告/${sub}/data/${key}.json`, JSON.stringify(mid.j, null, 2));
    console.log(`== [fanout] 取中位轮 r${mid.r} (span p99=${mid.score})`);
  }
'

echo "=== HTTP API 层(直连 server,20×10)==="
node http-bench.mjs 20 10 || echo "!! http-bench 失败"

echo "SPECIAL DONE"
