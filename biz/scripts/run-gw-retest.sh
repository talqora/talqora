#!/usr/bin/env bash
# 优化版重测:只跑过载敏感场景(S3 + tp_r20/r25/r30),3 轮取中位。
# 数据落 docs/监测设施/测试报告/26-9-16-gobiz/data/opt_<key>_gateway.json(与旧二进制区分)。
set -u
cd "$(dirname "$0")/../../perf"
ROUNDS="${ROUNDS:-3}"
OUT_SUBDIR="${OUT_SUBDIR:-26-9-16-gobiz}"

run_scenario() {
  local key="$1" conns="$2" rate="$3" dur="$4" ramp="$5" r
  for r in $(seq 1 "$ROUNDS"); do
    echo "=== [opt_$key] round $r/$ROUNDS (CONNS=$conns RATE=$rate DURATION=$dur RAMP=$ramp) ==="
    node ab-run.mjs gateway "opt_${key}_r${r}" "$conns" "$rate" "$dur" "$ramp" || echo "!! [opt_$key] round $r 失败"
    sleep 5
  done
  ROUNDS="$ROUNDS" OUT_SUBDIR="$OUT_SUBDIR" node -e '
    const fs = require("fs");
    const n = parseInt(process.env.ROUNDS || "3", 10);
    const sub = process.env.OUT_SUBDIR || "26-9-16-gobiz";
    const key = process.argv[1];
    const rounds = [];
    for (let r = 1; r <= n; r++) {
      const p = `../docs/监测设施/测试报告/${sub}/data/opt_${key}_r${r}.json`;
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const h = j.harness || {};
      rounds.push({ r, j, score: h.rttMs?.p99 ?? NaN });
    }
    if (!rounds.length) { console.error(`!! [opt_${key}] 无有效轮次`); process.exit(1); }
    rounds.sort((a, b) => a.score - b.score);
    const mid = rounds[Math.floor(rounds.length / 2)];
    fs.writeFileSync(`../docs/监测设施/测试报告/${sub}/data/opt_${key}_gateway.json`, JSON.stringify(mid.j, null, 2));
    console.log(`== [opt_${key}] 取中位轮 r${mid.r} (p99=${mid.score})`);
  ' "$key"
}

run_scenario s3 150 20 15 25
run_scenario tp_r20 100 20 20 25
run_scenario tp_r25 100 25 20 25
run_scenario tp_r30 100 30 20 25

echo "RETEST DONE"
