// Package logx 初始化全局 slog(JSON handler,与 gateway 一致)。
package logx

import (
	"log/slog"
	"os"
)

// Init 设置默认 logger:JSON handler 输出 stdout。
func Init() *slog.Logger {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	logger := slog.New(h)
	slog.SetDefault(logger)
	return logger
}
