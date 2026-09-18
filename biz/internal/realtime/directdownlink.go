// directdownlink.go:定向下行(V3 §4.3)——业务层按 presence.replica 把 DownlinkFrame
// 直接写进对应网关副本的 gRPC 下行流,替代 Redis pub/sub 全副本广播。
// gateway 侧接收端(RouteToUser)已就绪;本侧维护 replica→流 注册表(流建立时经
// x-replica-id metadata 关联),发送失败由调用方回退 pub/sub 兜底。
package realtime

import (
	"context"
	"sync"

	edgev1 "github.com/our-chat/biz/internal/contracts/gen/ourchat/edge/v1"
)

// replicaStreams replica id → 该副本的全部已建立流(4 流/副本,轮询选一)。
var replicaStreams sync.Map // string → *replicaEntry

type replicaEntry struct {
	mu      sync.Mutex
	streams []edgev1.Realtime_StreamServer
	next    int
}

// registerReplicaStream 流建立时登记(metadata 带 x-replica-id 的流才可定向)。
func registerReplicaStream(replica string, stream edgev1.Realtime_StreamServer) {
	v, _ := replicaStreams.LoadOrStore(replica, &replicaEntry{})
	e := v.(*replicaEntry)
	e.mu.Lock()
	e.streams = append(e.streams, stream)
	e.mu.Unlock()
}

// unregisterReplicaStream 流关闭时摘除。
func unregisterReplicaStream(replica string, stream edgev1.Realtime_StreamServer) {
	v, ok := replicaStreams.Load(replica)
	if !ok {
		return
	}
	e := v.(*replicaEntry)
	e.mu.Lock()
	for i, s := range e.streams {
		if s == stream {
			e.streams = append(e.streams[:i], e.streams[i+1:]...)
			break
		}
	}
	e.mu.Unlock()
}

// tryDirectDownlink 向 replica 的某条流轮询发送 DownlinkFrame。
// 成功返回 true;流不存在/发送失败返回 false(调用方回退 Redis pub/sub)。
func tryDirectDownlink(ctx context.Context, replica string, frame *edgev1.DownlinkFrame) bool {
	v, ok := replicaStreams.Load(replica)
	if !ok {
		return false
	}
	e := v.(*replicaEntry)
	e.mu.Lock()
	if len(e.streams) == 0 {
		e.mu.Unlock()
		return false
	}
	stream := e.streams[e.next%len(e.streams)]
	e.next++
	e.mu.Unlock()

	if err := stream.Send(&edgev1.EdgeFrame{
		Kind: &edgev1.EdgeFrame_Downlink{Downlink: frame},
	}); err != nil {
		return false
	}
	return true
}

// DirectDownlinkFunc 供 service 包注入的定向发送函数签名。
type DirectDownlinkFunc func(ctx context.Context, replica string, frame *edgev1.DownlinkFrame) bool

// DownlinkSender 返回定向发送器(nil 安全:service 侧判空后走 pub/sub)。
func DownlinkSender() DirectDownlinkFunc { return tryDirectDownlink }
