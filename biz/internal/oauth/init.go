package oauth

import (
	"context"
	"encoding/json"

	"github.com/our-chat/biz/internal/store"
)

// init.go:启动初始化(对齐 server/src/oauth/init.ts:seed 默认 client;
// 迁移已由 golang-migrate 承接,无需 applyPendingMigrations)。

// SeedClient 默认 client 定义(init.ts:25-46)。
type SeedClient struct {
	ClientID          string
	ClientName        string
	ClientType        string
	RedirectURIs      []string
	AllowedScopes     []string
	AllowedGrantTypes []string
}

// SeedDefaultClient upsert 默认 client(init.ts:49-62,dev 重启跟随 env 更新)。
func SeedDefaultClient(ctx context.Context, c SeedClient) error {
	redirects, _ := json.Marshal(c.RedirectURIs)
	scopes, _ := json.Marshal(c.AllowedScopes)
	grants, _ := json.Marshal(c.AllowedGrantTypes)
	_, err := store.PG().Exec(ctx, `
		INSERT INTO oauth_clients
			(client_id, client_name, client_type, redirect_uris, allowed_scopes, allowed_grant_types)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (client_id) DO UPDATE SET
			client_name = EXCLUDED.client_name,
			client_type = EXCLUDED.client_type,
			redirect_uris = EXCLUDED.redirect_uris,
			allowed_scopes = EXCLUDED.allowed_scopes,
			allowed_grant_types = EXCLUDED.allowed_grant_types`,
		c.ClientID, c.ClientName, c.ClientType, redirects, scopes, grants)
	return err
}
