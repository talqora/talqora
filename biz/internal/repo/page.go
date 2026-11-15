// Package repo 是数据访问层:每个领域一个文件/类型,SQL 只允许出现在这里。
// 上层(service)依赖接口,不依赖具体实现,便于用 fake 替换做单测。
package repo

// Page 是统一的键集分页参数:After 为上一页最后一条的游标(0 表示第一页)。
type Page struct {
	After int64
	Limit int
}

// Normalize 兜底非法入参:limit<=0 或 >200 时收敛到安全值。
func (p Page) Normalize(def, max int) Page {
	if p.Limit <= 0 {
		p.Limit = def
	}
	if p.Limit > max {
		p.Limit = max
	}
	return p
}

// Result 是统一的分页返回:HasMore 由「多取一条」判定,Next 供下一页使用。
type Result[T any] struct {
	Items   []T
	HasMore bool
	Next    int64
}

// paginate 统一「多取一条判断 hasMore」的逻辑:cursor 由调用方给出(好友取 friend_id,请求取 id)。
func paginate[T any](items []T, limit int, cursor func(T) int64) Result[T] {
	if limit > 0 && len(items) > limit {
		items = items[:limit]
		return Result[T]{Items: items, HasMore: true, Next: cursor(items[len(items)-1])}
	}
	var next int64
	if len(items) > 0 {
		next = cursor(items[len(items)-1])
	}
	return Result[T]{Items: items, Next: next}
}
