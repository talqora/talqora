package config

import (
	"os"
	"testing"
)

func TestLoadAllowedOriginsParsesList(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	t.Setenv("CLIENT_ORIGINS", "http://a.example, https://b.example ,,")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load 失败: %v", err)
	}
	want := []string{"http://a.example", "https://b.example"}
	if len(cfg.AllowedOrigins) != len(want) {
		t.Fatalf("期望 %v,实际 %v", want, cfg.AllowedOrigins)
	}
	for i := range want {
		if cfg.AllowedOrigins[i] != want[i] {
			t.Fatalf("期望 %v,实际 %v", want, cfg.AllowedOrigins)
		}
	}
}

func TestLoadAllowedOriginsEmptyWhenUnset(t *testing.T) {
	t.Setenv("JWT_SECRET", "test-secret")
	if err := os.Unsetenv("CLIENT_ORIGINS"); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load 失败: %v", err)
	}
	if len(cfg.AllowedOrigins) != 0 {
		t.Fatalf("未设置时白名单应为空(全部放行),实际 %v", cfg.AllowedOrigins)
	}
}
