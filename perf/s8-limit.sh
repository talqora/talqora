#!/usr/bin/env bash
# S8 极限测试驱动器(SOP V3 §6「阶段 2 后置」)
#
# 做三件事:
#   1) 单变量阶梯:一次只抬一个维度(MODE=conns 抬连接数 / MODE=rate 抬消息率),每级跑满 DURATION 秒稳态;
#   2) 多判据停止:建连成功率、错误率、p99 超线性、服务端 CPU、goroutine 增长、压测机饱和——记录"哪条先触发";
#   3) 输出拐点表 + 区间:脚本不替你判定 Knee/Cliff,只把每级证据摊开,归因写在报告里。
#
# 用法:
#   MODE=conns LEVELS="2000,4000,6000" bash s8-limit.sh
#   MODE=rate  LEVELS="10,20,30"       bash s8-limit.sh
#   MODE=conns START=2000 GROWTH=1.5 MAX_LEVELS=4 bash s8-limit.sh     # 自动生成级次
#
# 二分细化:第一遍跑出 [last-ok, first-fail] 后,用 LEVELS 显式指定中间级别再跑一遍。
set -u
cd "$(dirname "$0")"

OUT_SUBDIR="${OUT_SUBDIR:-26-11-15-全Go体系V3基线}"
MODE="${MODE:-conns}"                 # conns | rate
DURATION="${DURATION:-60}"            # 每级稳态时长(秒),SOP 要求 ≥60
RAMP="${RAMP:-50}"                    # 爬坡速率(条/秒)
CONNS_FIXED="${CONNS_FIXED:-100}"     # MODE=rate 时固定的连接数
RATE_FIXED="${RATE_FIXED:-5}"         # MODE=conns 时固定的每连接速率
PREFIX="${PREFIX:-s8}"
NCPU="${NCPU:-18}"                    # 压测机核数,用于算 CPU 占用比例
STOP_CONN_OK="${STOP_CONN_OK:-0.95}"
STOP_ERR_RATE="${STOP_ERR_RATE:-0.01}"
STOP_P99_RATIO="${STOP_P99_RATIO:-2}"
STOP_CPU_PCT="${STOP_CPU_PCT:-85}"    # 服务端 CPU 占 NCPU 的百分比
STOP_GOROUTINE_RATIO="${STOP_GOROUTINE_RATIO:-1.5}"
BENCH_CPU_STOP="${BENCH_CPU_STOP:-70}"  # 压测端自身 CPU(占 NCPU) 超过则本级作废

# 判据在 node 子进程里读,必须 export;漏一个该判据就静默失效(首版曾因此未能在 27 级停下)。
export STOP_CONN_OK STOP_ERR_RATE STOP_P99_RATIO STOP_CPU_PCT STOP_GOROUTINE_RATIO BENCH_CPU_STOP NCPU
SLEEP_BETWEEN="${SLEEP_BETWEEN:-8}"
START="${START:-2000}"
GROWTH="${GROWTH:-1.5}"
MAX_LEVELS="${MAX_LEVELS:-5}"

# ---- 级次解析:显式 LEVELS 优先,否则按 START×GROWTH 生成 ----
if [ -n "${LEVELS:-}" ]; then
  IFS=',' read -r -a LV <<< "$LEVELS"
else
  LV=(); cur="$START"
  for _ in $(seq 1 "$MAX_LEVELS"); do
    LV+=("$(printf '%.0f' "$cur")"); cur=$(echo "$cur * $GROWTH" | bc -l)
  done
fi

RESULTS="$OUT_SUBDIR"
mkdir -p "../docs/监测设施/测试报告/$RESULTS/data"
CSV="../docs/监测设施/测试报告/$RESULTS/data/${PREFIX}_${MODE}_table.csv"
echo "level,conns,rate,connected,attempted,sent,ack,errRate,p50,p95,p99,srvCpuCores,srvCpuPct,gwCpuCores,goroutines,rssMB,benchCpuPct,trigger" > "$CSV"

prev_p99=""; prev_gor=""
overall_status=0

printf '\n===== S8 极限测试 MODE=%s 级次=%s =====\n' "$MODE" "${LV[*]}"

for lvl in "${LV[@]}"; do
  if [ "$MODE" = "conns" ]; then CONNS="$lvl"; RATE="$RATE_FIXED"; else CONNS="$CONNS_FIXED"; RATE="$lvl"; fi
  label="${PREFIX}_${MODE}_${lvl}"
  printf '\n--- 级别 %s (CONNS=%s RATE=%s DURATION=%ss) ---\n' "$lvl" "$CONNS" "$RATE" "$DURATION"

  # time -p 统计整棵进程树的 CPU(压测端饱和代理指标)
  start_ts=$(date +%s)
  ( time -p env OUT_SUBDIR="$OUT_SUBDIR" node ab-run.mjs gateway "$label" "$CONNS" "$RATE" "$DURATION" "$RAMP" ) >/dev/null 2>/tmp/s8_time.txt
  wall=$(( $(date +%s) - start_ts ))
  bench_cpu_s=$(awk '/^user|^sys/{s+=$2} END{print s+0}' /tmp/s8_time.txt)
  bench_cpu_pct=$(awk -v s="$bench_cpu_s" -v w="$wall" -v n="$NCPU" 'BEGIN{if(w>0)printf "%.1f", s/w/n*100; else print 0}')

  json="../docs/监测设施/测试报告/$OUT_SUBDIR/data/${label}.json"
  if [ ! -f "$json" ]; then
    echo "!! 级别 $lvl 未产出 $json,中止(环境可能已崩,按 §7.1-1 恢复后重跑本级)"
    overall_status=1
    break
  fi

  # ---- 判据评估:输出 CSV 行 + trigger 字段 ----
  # 上一级基线必须在评估前注入,否则"p99 超线性/goroutine 增长"两条判据永远不生效。
  export PREV_P99="$prev_p99" PREV_GOR="$prev_gor" LEVEL="$lvl" BENCH_CPU="$bench_cpu_pct"
  row=$(node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const h = j.harness || {}, r = j.resource || {};
    const conns = j.params?.CONNS ?? 0, rate = j.params?.RATE ?? 0;
    const attempted = h.attempted || 0, connected = h.connectedCount || 0;
    const sent = h.sent || 0, ack = h.ack || 0;
    const errs = Object.values(h.errors || {}).reduce((a, b) => a + b, 0);
    const errRate = sent ? errs / sent : 0;
    const connOk = attempted ? connected / attempted : 0;
    const win = j.windowSec || 1;
    const srvCores = (r.serverCpuSecondsDelta || 0) / win;
    const srvPct = srvCores / Number(process.env.NCPU || 18) * 100;
    const gwCores = (r.gatewayCpuSecondsDelta || 0) / win;
    const p99 = h.rttMs?.p99 ?? NaN;
    const trig = [];
    if (connOk < Number(process.env.STOP_CONN_OK)) trig.push(`connOk=${(connOk*100).toFixed(1)}%`);
    if (errRate > Number(process.env.STOP_ERR_RATE)) trig.push(`errRate=${(errRate*100).toFixed(2)}%`);
    if (srvPct > Number(process.env.STOP_CPU_PCT)) trig.push(`srvCpu=${srvPct.toFixed(0)}%`);
    if (process.env.PREV_P99 && Number.isFinite(p99)) {
      const ratio = p99 / Number(process.env.PREV_P99);
      if (ratio > Number(process.env.STOP_P99_RATIO)) trig.push(`p99x${ratio.toFixed(2)}`);
    }
    if (process.env.PREV_GOR && r.peakGoroutines) {
      const ratio = r.peakGoroutines / Number(process.env.PREV_GOR);
      if (ratio > Number(process.env.STOP_GOROUTINE_RATIO)) trig.push(`gorx${ratio.toFixed(2)}`);
    }
    if (Number(process.env.BENCH_CPU_STOP) > 0 && Number(process.env.BENCH_CPU) > Number(process.env.BENCH_CPU_STOP)) {
      trig.push(`benchCpu=${process.env.BENCH_CPU}%(本级作废)`);
    }
    const f = (x) => Number.isFinite(x) ? Math.round(x) : "";
    console.log([
      process.env.LEVEL, conns, rate, connected, attempted, sent, ack,
      errRate.toFixed(4), f(h.rttMs?.p50), f(h.rttMs?.p95), f(p99),
      srvCores.toFixed(2), srvPct.toFixed(1), gwCores.toFixed(2),
      r.peakGoroutines ?? "", r.peakServerRssMB ?? "", process.env.BENCH_CPU,
      trig.join("|") || "-"
    ].join(","));
    console.error(JSON.stringify({ p99, gor: r.peakGoroutines || 0, trig }));
  ' "$json" 2>/tmp/s8_eval.txt)

  echo "$row" >> "$CSV"
  echo "$row" | awk -F, '{printf "  连接 %s/%s  发送 %s  ack %s  错误率 %s%%  p99 %sms  服务端CPU %s%%  goroutine %s  RSS %sMB\n", $4,$5,$6,$7,$8*100,$11,$13,$15,$16}'

  meta=$(cat /tmp/s8_eval.txt)
  trig=$(echo "$row" | awk -F, '{print $NF}')
  prev_p99=$(node -e 'const m=JSON.parse(process.argv[1]||"{}");if(Number.isFinite(m.p99))console.log(m.p99)' "$meta")
  prev_gor=$(node -e 'const m=JSON.parse(process.argv[1]||"{}");if(m.gor)console.log(m.gor)' "$meta")

  if [ "$trig" != "-" ]; then
    printf '  >>> 停止判据触发:%s\n' "$trig"
    break
  fi
  sleep "$SLEEP_BETWEEN"
done

echo ""
echo "===== 拐点表(CSV: $CSV) ====="
column -s, -t < "$CSV" 2>/dev/null || cat "$CSV"
echo ""
echo "说明:本表只给证据,不给结论。Knee/Cliff 的判定与'先失效环节'的归因写在报告里(SOP §9.2 第 15 条)。"
exit "$overall_status"
