#!/usr/bin/env bash
# resmon.sh —— 三级资源采样:宿主机 / colima VM / 容器
#
# 为什么需要它:压测只看 biz/gateway 的 /metrics,回答不了"这台机器当时还剩多少余量"
# 以及"其他东西吃了多少"。SOP V3 §2.1 要求的"背景负载"字段,由本脚本提供原始数据。
#
# 用法:
#   bash resmon.sh <输出.jsonl> [DURATION=60] [INTERVAL=3]
#   OUT_SUBDIR=<期目录> bash resmon.sh ../docs/监测设施/测试报告/<期>/data/resmon_idle.jsonl 60
#
# 采什么(每 interval 一行 JSONL):
#   host.cpu_user/sys/idle(%)  host.load1/5/15  host.mem_used_mb  host.swap_used_mb
#   host.disk_mbs  host.net_rx_mbps/net_tx_mbps(区间增量)
#   vm.load1  vm.mem_used_mb  vm.mem_total_mb
#   ctr.cpu_pct_sum  ctr.mem_mb_sum  ctr.count   ← 其他项目容器合计(排除 our-chat-*)
#   self.cpu_pct_p95  ← 采样器自身进程树峰值,用于判断"采样本身是否构成干扰"
set -u

OUT="${1:-/tmp/resmon.jsonl}"
DURATION="${DURATION:-60}"
INTERVAL="${INTERVAL:-3}"
PAGESIZE=$(sysctl -n hw.pagesize 2>/dev/null || echo 16384)

: > "$OUT"
START=$(date +%s)
END=$((START + DURATION))
echo "[resmon] 输出=$OUT 时长=${DURATION}s 间隔=${INTERVAL}s pagesize=$PAGESIZE" >&2

prev_net=""; prev_disk=""; tick=0

while [ "$(date +%s)" -lt "$END" ]; do
  tick=$((tick + 1))
  tick_start=$(date +%s)
  ts=$(date +%Y-%m-%dT%H:%M:%S%z)

  # ---- 宿主机 CPU / load ----
  topout=$(top -l 1 -n 0 2>/dev/null)
  cpu_user=$(echo "$topout" | awk -F'[:,%]' '/CPU usage/ {gsub(/ /,"",$2); print $2+0}')
  cpu_sys=$(echo "$topout" | awk -F'[:,%]' '/CPU usage/ {gsub(/ /,"",$4); print $4+0}')
  cpu_idle=$(echo "$topout" | awk -F'[:,%]' '/CPU usage/ {gsub(/ /,"",$6); print $6+0}')
  load=$(echo "$topout" | awk '/Load Avg/ {gsub(/,/," ",$0); print $3, $4, $5}')
  l1=$(echo "$load" | awk '{print $1}'); l5=$(echo "$load" | awk '{print $2}'); l15=$(echo "$load" | awk '{print $3}')

  # ---- 宿主机内存 ----
  vm=$(vm_stat 2>/dev/null)
  pg(){ echo "$vm" | awk -v k="$1" -F: '$1 ~ k {gsub(/[ .]/,"",$2); print $2+0}'; }
  active=$(pg "Pages active"); wired=$(pg "Pages wired"); comp=$(pg "Pages occupied by compressor"); free=$(pg "Pages free")
  mem_used_mb=$(( (active + wired + comp) * PAGESIZE / 1048576 ))
  mem_free_mb=$(( free * PAGESIZE / 1048576 ))
  comp_mb=$(( comp * PAGESIZE / 1048576 ))
  swap_used_mb=$(sysctl -n vm.swapusage 2>/dev/null | awk -F'used = ' '{split($2,a,"M"); print a[1]+0}')
  # 换页速率:Pageouts 增量 → 每分钟换出页数。持续 >0 说明内存不够,压测时 DB 缓存会被冲掉。
  po=$(pg "Pageouts"); pi=$(pg "Pageins")
  po_rate=0; pi_rate=0
  if [ -n "${prev_po:-}" ]; then
    dpo=$(( po - prev_po )); dpi=$(( pi - prev_pi ))
    [ "$dpo" -lt 0 ] && dpo=0; [ "$dpi" -lt 0 ] && dpi=0
    po_rate=$(awk -v d="$dpo" -v i="$INTERVAL" 'BEGIN{printf "%.0f", d*60/i}')
    pi_rate=$(awk -v d="$dpi" -v i="$INTERVAL" 'BEGIN{printf "%.0f", d*60/i}')
  fi
  prev_po=$po; prev_pi=$pi

  # ---- 磁盘吞吐:iostat -c 2 要等 2 秒,开销大,错峰到每 3 个 tick 采一次 ----
  if [ $((tick % 3)) -eq 1 ] || [ -z "${disk:-}" ]; then
    disk=$(iostat -d -c 2 2>/dev/null | tail -1 | awk '{print $3+0}')
    [ -z "$disk" ] && disk=0
  fi

  # ---- 网络吞吐(累计字节取差)----
  net=$(netstat -ib 2>/dev/null | awk '/^en0/ && $7 ~ /^[0-9]+$/ {i+=$7; o+=$10} END{print i+0, o+0}')
  rx=0; tx=0
  if [ -n "$prev_net" ]; then
    p_rx=$(echo "$prev_net" | awk '{print $1}'); p_tx=$(echo "$prev_net" | awk '{print $2}')
    d_rx=$(( $(echo "$net" | awk '{print $1}') - p_rx )); d_tx=$(( $(echo "$net" | awk '{print $2}') - p_tx ))
    [ "$d_rx" -lt 0 ] && d_rx=0; [ "$d_tx" -lt 0 ] && d_tx=0
    rx=$(awk -v b="$d_rx" -v i="$INTERVAL" 'BEGIN{printf "%.2f", b*8/i/1000000}')
    tx=$(awk -v b="$d_tx" -v i="$INTERVAL" 'BEGIN{printf "%.2f", b*8/i/1000000}')
  fi
  prev_net="$net"

  # ---- colima VM(较慢,每 5 个 tick 采一次,其余沿用上次)----
  if [ $((tick % 5)) -eq 1 ] || [ -z "${vm_load:-}" ]; then
    vmstat=$(colima ssh -- sh -c 'cat /proc/loadavg; free -m | sed -n 2p' 2>/dev/null | tr -d '\r')
    vm_load=$(echo "$vmstat" | awk 'NR==1{print $1}')
    vm_mem_total=$(echo "$vmstat" | awk 'NR==2{print $2}')
    vm_mem_used=$(echo "$vmstat" | awk 'NR==2{print $3}')
  fi

  # ---- 容器占用(排除本项目):docker stats 单次约 2s,错峰到每 2 个 tick 采一次 ----
  if [ $((tick % 2)) -eq 1 ] || [ -z "${ctr_cpu:-}" ]; then
    ctr=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' 2>/dev/null | grep -v '^our-chat' )
    ctr_cpu=$(echo "$ctr" | awk '{gsub(/%/,"",$2); s+=$2} END{printf "%.1f", s+0}')
    ctr_mem=$(echo "$ctr" | awk '{split($3,a,"/"); gsub(/[A-Za-z]/,"",a[1]); v=a[1]+0; if($3 ~ /GiB/) v*=1024; else if($3 ~ /KiB/) v/=1024; s+=v} END{printf "%.0f", s+0}')
    ctr_n=$(echo "$ctr" | grep -c . )
  fi

  # ---- 采样周期自身耗时(衡量采样开销,比 ps %cpu 可靠)----
  tick_ms=$(( ($(date +%s) - tick_start) * 1000 ))

  printf '{"ts":"%s","host":{"cpu_user":%s,"cpu_sys":%s,"cpu_idle":%s,"load1":%s,"load5":%s,"load15":%s,"mem_used_mb":%s,"mem_free_mb":%s,"compressor_mb":%s,"swap_used_mb":%s,"pageout_per_min":%s,"pagein_per_min":%s,"disk_mbs":%s,"net_rx_mbps":%s,"net_tx_mbps":%s},"vm":{"load1":%s,"mem_used_mb":%s,"mem_total_mb":%s},"ctr":{"cpu_pct_sum":%s,"mem_mb_sum":%s,"count":%s},"sampler":{"tick_ms":%s}}\n' \
    "$ts" "$cpu_user" "$cpu_sys" "$cpu_idle" "${l1:-0}" "${l5:-0}" "${l15:-0}" \
    "$mem_used_mb" "$mem_free_mb" "${comp_mb:-0}" "${swap_used_mb:-0}" "$po_rate" "$pi_rate" "${disk:-0}" "$rx" "$tx" \
    "${vm_load:-0}" "${vm_mem_used:-0}" "${vm_mem_total:-0}" \
    "${ctr_cpu:-0}" "${ctr_mem:-0}" "${ctr_n:-0}" "$tick_ms" >> "$OUT"

  sleep "$INTERVAL"
done

echo "[resmon] 完成,共 $tick 个采样点 → $OUT" >&2
