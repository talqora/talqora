#!/usr/bin/env bash
# 专项补测:仅 S7 惊群 ×3 + 群扇出 ×3(3 轮取中位,修复 OUT_SUBDIR 未导出导致轮次丢失的问题)。
# 前置:Go 业务层(:3007+3008)+ gateway(:8090)+ Prometheus 运行中。
set -u
cd "$(dirname "$0")/../../perf"
export OUT_SUBDIR="${OUT_SUBDIR:-26-9-17-gobiz}"
DATA_DIR="../docs/监测设施/测试报告/${OUT_SUBDIR}/data"

echo "=== S7 惊群重连 ×3 ==="
for r in 1 2 3; do
  echo "--- s7 round $r ---"
  node gw-storm-reconnect.mjs 300 50 || echo "!! s7 round $r 失败"
  cp "$DATA_DIR/s7_storm_gateway.json" "$DATA_DIR/s7_storm_gateway_r${r}.json" || echo "!! s7 r${r} 拷贝失败"
  sleep 5
done
OUT_SUBDIR="$OUT_SUBDIR" node -e '
  const fs = require("fs");
  const sub = process.env.OUT_SUBDIR;
  const key = "s7_storm_gateway";
  const rounds = [];
  for (let r = 1; r <= 3; r++) {
    const p = `../docs/监测设施/测试报告/${sub}/data/${key}_r${r}.json`;
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    rounds.push({ r, j, score: j.stormReconnect?.p99 ?? NaN });
  }
  if (!rounds.length) { console.error("!! [s7] 无有效轮次"); process.exit(1); }
  rounds.sort((a, b) => a.score - b.score);
  const mid = rounds[Math.floor(rounds.length / 2)];
  fs.writeFileSync(`../docs/监测设施/测试报告/${sub}/data/${key}.json`, JSON.stringify(mid.j, null, 2));
  console.log(`== [s7] 取中位轮 r${mid.r} (p99=${mid.score})`);
'

echo "=== 群扇出 ×3(100 成员,1 人发 20 条,GROUP_ID=9000002)==="
for r in 1 2 3; do
  echo "--- fanout round $r ---"
  node gw-fanout-bench.mjs 100 20 9000002 || echo "!! fanout round $r 失败"
  cp "$DATA_DIR/fanout_bench_gateway.json" "$DATA_DIR/fanout_bench_gateway_r${r}.json" || echo "!! fanout r${r} 拷贝失败"
  sleep 5
done
OUT_SUBDIR="$OUT_SUBDIR" node -e '
  const fs = require("fs");
  const sub = process.env.OUT_SUBDIR;
  const key = "fanout_bench_gateway";
  const rounds = [];
  for (let r = 1; r <= 3; r++) {
    const p = `../docs/监测设施/测试报告/${sub}/data/${key}_r${r}.json`;
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    rounds.push({ r, j, score: j.fanoutSpanMs?.p99 ?? NaN });
  }
  if (!rounds.length) { console.error("!! [fanout] 无有效轮次"); process.exit(1); }
  rounds.sort((a, b) => a.score - b.score);
  const mid = rounds[Math.floor(rounds.length / 2)];
  fs.writeFileSync(`../docs/监测设施/测试报告/${sub}/data/${key}.json`, JSON.stringify(mid.j, null, 2));
  console.log(`== [fanout] 取中位轮 r${mid.r} (span p99=${mid.score})`);
'

echo "FANOUT-STORM DONE"
