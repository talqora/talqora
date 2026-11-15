package repo

import (
	"context"
	"fmt"

	"github.com/our-chat/biz/internal/db"
)

// QueryRows 执行只读查询并按列名返回原始行。
// 用途:有些端点对外契约就是「数据库行形态」(snake_case),迁移时保持字节级兼容,
// 避免在 api 层重写映射逻辑;列名来自 SQL,不来自用户输入。
func QueryRows(ctx context.Context, sql string, args ...any) ([]map[string]any, error) {
	rows, err := db.RO().Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	out := []map[string]any{}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		m := make(map[string]any, len(fields))
		for i, f := range fields {
			m[string(f.Name)] = vals[i]
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Exec 执行写语句(事务外)。
func Exec(ctx context.Context, sql string, args ...any) error {
	_, err := db.PG().Exec(ctx, sql, args...)
	return err
}

// Sprintf 仅用于 repo 内部拼接 SQL 片段(占位符序号),避免各文件重复 import fmt。
func Sprintf(format string, a ...any) string { return fmt.Sprintf(format, a...) }
