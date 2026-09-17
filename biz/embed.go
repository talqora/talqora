// Package biz 是 module 根包,承载跨包资源嵌入(migrations 目录位于 biz/migrations,
// 而 embed 指令不能引用父目录,故由根包统一嵌入后注入 internal/migrate)。
package biz

import "embed"

//go:embed migrations
var MigrationsFS embed.FS
