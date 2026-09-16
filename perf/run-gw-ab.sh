#!/usr/bin/env bash
# gateway A/B 压测跑批:每个场景 3 轮 → 取 RTT p99 中位轮落盘为 <key>_gateway.json。
# 参数与 26-9-14 纯 Node 基线完全一致(见 docs/监测设施/测试报告/26-9-14/README.md)。
# 前置:server(REALTIME_MODE=gateway)+ gateway(:8090)+ Prometheus 已启动。
set -u
cd "$(dirname "$0")"
ROUNDS="${ROUNDS:-3}"

run_scenario() { # key conns rate dur ramp
  local key="$1" conns="$2" rate="$3" dur="$4" ramp="$5" r
  for r in $(seq 1 "$ROUNDS"); do
    echo "=== [$key] round $r/$ROUNDS (CONNS=$conns RATE=$rate DURATION=$dur RAMP=$ramp) ==="
    node ab-run.mjs gateway "${key}_gateway_r${r}" "$conns" "$rate" "$dur" "$ramp" || echo "!! [$key] round $r 失败"
    sleep 5
  done
  # 取中位轮(按 harness.rttMs.p99,缺失则按 ack/sent 倒序)
  ROUNDS="$ROUNDS" node -e '
    const fs = require("fs");
    const n = parseInt(process.env.ROUNDS || "3", 10);
    const key = process.argv[1];
    const rounds = [];
    for (let r = 1; r <= n; r++) {
      const p = `../docs/监测设施/测试报告/data/${key}_gateway_r${r}.json`;
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      const h = j.harness || {};
      rounds.push({ r, j, score: h.rttMs?.p99 ?? (h.ack != null && h.sent ? -(h.ack / h.sent) : NaN) });
    }
    if (!rounds.length) { console.error(`!! [${key}] 无有效轮次`); process.exit(1); }
    rounds.sort((a, b) => a.score - b.score);
    const mid = rounds[Math.floor(rounds.length / 2)];
    fs.writeFileSync(`../docs/监测设施/测试报告/data/${key}_gateway.json`, JSON.stringify(mid.j, null, 2));
    console.log(`== [${key}] 取中位轮 r${mid.r} (p99=${mid.score}) 落盘 ${key}_gateway.json`);
  ' "$key"
}

run_scenario s0 50 2 15 10
run_scenario s1 100 10 20 25
run_scenario s2 300 2 15 25
run_scenario s3 150 20 15 25
run_scenario s4 500 1 15 50
run_scenario s5 100 5 120 25
run_scenario tp_r10 100 10 20 25
run_scenario tp_r15 100 15 20 25
run_scenario tp_r20 100 20 20 25
run_scenario tp_r25 100 25 20 25
run_scenario tp_r30 100 30 20 25

echo "ALL SCENARIOS DONE"
