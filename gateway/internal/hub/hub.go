// Package hub 维护本副本持有的全部连接,并提供下行路由(把 backplane 收到的下行帧投给本地连接)。
// 网关无状态:连接的可发现状态(在哪台副本)全在 Redis presence,hub 只是本进程的 fd 索引(docs 16 §4.3)。
package hub

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/our-chat/gateway/internal/metrics"
	"github.com/our-chat/gateway/internal/upstream"
)

// ErrOverQuota 表示本副本连接数已达硬上限,拒绝新连接(防 fd/内存爆,docs 16 坑6)。
var ErrOverQuota = errors.New("网关连接数已达上限")

// presenceRegistry 是连接登记表的最小抽象,生产实现为 presence.Registry(Redis),
// 测试装配可用 fake 替换,避免硬依赖 Redis。
type presenceRegistry interface {
	Register(ctx context.Context, userID int64, deviceID, socketID string) error
	Refresh(ctx context.Context, userID int64, deviceID string) error
	Remove(ctx context.Context, userID int64, deviceID string) error
}

type Hub struct {
	mu    sync.RWMutex
	conns map[int64]map[string]*Conn // userID → deviceId → 连接

	maxConns         int
	sendBuffer       int
	heartbeatTimeout time.Duration

	presence presenceRegistry
	upstream upstream.Upstream // 上行通道抽象(http 或 grpc 流实现)
	// concurrentUpstream 表示上行通道支持每连接并发上行(grpc 流);false 时读循环串行等回包(http 模式)。
	concurrentUpstream bool
	log                *slog.Logger
}

func New(maxConns, sendBuffer int, heartbeatTimeout time.Duration, p presenceRegistry, up upstream.Upstream, log *slog.Logger) *Hub {
	concurrent := false
	if up != nil {
		concurrent = up.ConcurrentSafe()
	}
	return &Hub{
		conns:              make(map[int64]map[string]*Conn),
		maxConns:           maxConns,
		sendBuffer:         sendBuffer,
		heartbeatTimeout:   heartbeatTimeout,
		presence:           p,
		upstream:           up,
		concurrentUpstream: concurrent,
		log:                log,
	}
}

// NewConn 构造一条连接并接入 hub:配额校验通过即登记到本地索引,返回的连接由调用方启动读写循环。
// 同 (userID, deviceId) 重连时踢掉旧连接(同设备只保留最新一条,避免幽灵连接,docs 16 §5.1)。
func (h *Hub) NewConn(userID int64, deviceID, socketID string, ws *websocket.Conn) (*Conn, error) {
	c := &Conn{
		userID:   userID,
		deviceID: deviceID,
		socketID: socketID,
		ws:       ws,
		send:     make(chan []byte, h.sendBuffer),
		hub:      h,
		closed:   make(chan struct{}),
		sem:      make(chan struct{}, inflightLimit),
		inflight: make(map[string]struct{}),
	}

	h.mu.Lock()
	if h.countLocked() >= h.maxConns {
		h.mu.Unlock()
		return nil, ErrOverQuota
	}
	devices := h.conns[userID]
	if devices == nil {
		devices = make(map[string]*Conn)
		h.conns[userID] = devices
	}
	old := devices[deviceID]
	devices[deviceID] = c
	h.mu.Unlock()

	if old != nil {
		old.close() // 同设备旧连接踢下线(close 幂等)
	}
	metrics.Connections.Inc()
	return c, nil
}

func (h *Hub) unregister(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	devices := h.conns[c.userID]
	if devices == nil {
		return
	}
	// 仅当索引里仍是这条连接才删——避免同设备重连后误删新连接。
	if devices[c.deviceID] == c {
		delete(devices, c.deviceID)
	}
	if len(devices) == 0 {
		delete(h.conns, c.userID)
	}
}

// RouteToUser 把一条下行帧投给某用户在本副本的连接,支持设备级过滤:
//   - targetDeviceID 非空 → 仅投该设备(call:rejoin 属主路由);
//   - exceptDeviceID 非空 → 投该用户除指定设备外的全部连接(read.sync 排除本端);
//   - 两者皆空 → 投该用户全部连接(多端同收)。
//
// 二者语义互斥(由上游保证不同时非空);任一连接 send 缓冲打满即逐出该慢消费者(背压),
// 但不影响同用户其它正常连接。
func (h *Hub) RouteToUser(userID int64, targetDeviceID, exceptDeviceID string, payload []byte) {
	h.mu.RLock()
	devices := h.conns[userID]
	targets := make([]*Conn, 0, len(devices))
	for _, c := range devices {
		if targetDeviceID != "" && c.deviceID != targetDeviceID {
			continue
		}
		if exceptDeviceID != "" && c.deviceID == exceptDeviceID {
			continue
		}
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	if len(targets) == 0 {
		metrics.Downlink.WithLabelValues("dropped").Inc() // 本副本无此用户连接(可能在别的副本)
		return
	}
	for _, c := range targets {
		if c.enqueue(payload) {
			metrics.Downlink.WithLabelValues("delivered").Inc()
		} else {
			metrics.Downlink.WithLabelValues("evicted").Inc()
			metrics.Evicted.Inc()
			c.close() // 慢消费者:缓冲打满,逐出(docs 16 §4.4)
		}
	}
}

func (h *Hub) countLocked() int {
	n := 0
	for _, devices := range h.conns {
		n += len(devices)
	}
	return n
}

// ShutdownAll 向全部存量连接写一条 close 帧(默认 1012 Service Restart),
// 引导客户端主动重连到其它副本,配合缩容/滚动发布的 drain 流程。
// 只发帧不关连接:让客户端侧先感知迁移,底层连接随后由 HTTP 服务关闭统一收尾。
func (h *Hub) ShutdownAll(code int, text string) {
	h.mu.RLock()
	all := make([]*Conn, 0)
	for _, devices := range h.conns {
		for _, c := range devices {
			all = append(all, c)
		}
	}
	h.mu.RUnlock()

	msg := websocket.FormatCloseMessage(code, text)
	for _, c := range all {
		// WriteControl 单条连接写失败只影响该连接,不阻塞批量流程。
		_ = c.ws.WriteControl(websocket.CloseMessage, msg, time.Now().Add(time.Second))
	}
}

// Start 启动一条连接的读写循环(各占一个 goroutine)。
func (h *Hub) Start(c *Conn) {
	go c.writeLoop()
	go c.readLoop()
}
