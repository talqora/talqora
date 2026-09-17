package oauth

import (
	"context"
	"encoding/json"

	"golang.org/x/crypto/bcrypt"

	"github.com/our-chat/biz/internal/store"
)

// clients.go:oauth_clients 查询 + client_secret 校验(对齐 server/src/oauth/clients.ts)。

// OAuthClient 客户端模型(types.ts:8-20)。
type OAuthClient struct {
	ClientID           string   `json:"client_id"`
	ClientName         string   `json:"client_name"`
	ClientType         string   `json:"client_type"`
	ClientSecretHash   *string  `json:"client_secret_hash"`
	RedirectURIs       []string `json:"redirect_uris"`
	AllowedScopes      []string `json:"allowed_scopes"`
	AllowedGrantTypes  []string `json:"allowed_grant_types"`
	TokenLifetimeSec   int      `json:"token_lifetime_sec"`
	RefreshLifetimeSec int      `json:"refresh_lifetime_sec"`
	RequirePkce        bool     `json:"require_pkce"`
	Disabled           bool     `json:"disabled"`
}

// FindClient 按 clientId 查客户端(clients.ts:26-29)。
func FindClient(ctx context.Context, clientID string) (*OAuthClient, error) {
	var c OAuthClient
	var secretHash *string
	var redirectRaw, scopesRaw, grantsRaw []byte
	err := store.PG().QueryRow(ctx, `
		SELECT client_id, client_name, client_type, client_secret_hash, redirect_uris,
			allowed_scopes, allowed_grant_types, token_lifetime_sec, refresh_lifetime_sec,
			require_pkce, disabled
		FROM oauth_clients WHERE client_id = $1`, clientID,
	).Scan(&c.ClientID, &c.ClientName, &c.ClientType, &secretHash, &redirectRaw,
		&scopesRaw, &grantsRaw, &c.TokenLifetimeSec, &c.RefreshLifetimeSec,
		&c.RequirePkce, &c.Disabled)
	if isNoRowsErr(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.ClientSecretHash = secretHash
	_ = json.Unmarshal(redirectRaw, &c.RedirectURIs)
	_ = json.Unmarshal(scopesRaw, &c.AllowedScopes)
	_ = json.Unmarshal(grantsRaw, &c.AllowedGrantTypes)
	return &c, nil
}

// RequireActiveClient 取活跃客户端(clients.ts:31-37)。
func RequireActiveClient(ctx context.Context, clientID string) (*OAuthClient, error) {
	if clientID == "" {
		return nil, NewOAuthError(ErrInvalidRequest, "client_id 缺失")
	}
	c, err := FindClient(ctx, clientID)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, NewOAuthError(ErrInvalidClient, "client 未注册")
	}
	if c.Disabled {
		return nil, NewOAuthError(ErrInvalidClient, "client 已停用")
	}
	return c, nil
}

// AuthenticateClient confidential 校验 secret,public 不允许带(clients.ts:40-58)。
func AuthenticateClient(c *OAuthClient, clientSecret *string) error {
	if c.ClientType == "public" {
		if clientSecret != nil {
			return NewOAuthError(ErrInvalidClient, "public client 不应提供 client_secret")
		}
		return nil
	}
	if clientSecret == nil || *clientSecret == "" {
		return NewOAuthError(ErrInvalidClient, "缺少 client_secret")
	}
	if c.ClientSecretHash == nil {
		return NewOAuthError(ErrInvalidClient, "client 未设置 secret")
	}
	if bcrypt.CompareHashAndPassword([]byte(*c.ClientSecretHash), []byte(*clientSecret)) != nil {
		return NewOAuthError(ErrInvalidClient, "client_secret 无效")
	}
	return nil
}

// AssertRedirectURIIsAllowed redirect_uri 必须 exact match(clients.ts:61-71)。
func AssertRedirectURIIsAllowed(c *OAuthClient, redirectURI string) error {
	if redirectURI == "" {
		return NewOAuthError(ErrInvalidRequest, "redirect_uri 缺失")
	}
	for _, u := range c.RedirectURIs {
		if u == redirectURI {
			return nil
		}
	}
	return NewOAuthError(ErrInvalidRequest, "redirect_uri 未注册")
}

// AssertGrantAllowed grant_type 白名单(clients.ts:73-77)。
func AssertGrantAllowed(c *OAuthClient, grantType string) error {
	for _, g := range c.AllowedGrantTypes {
		if g == grantType {
			return nil
		}
	}
	return NewOAuthError(ErrUnauthorizedClient, "不允许的 grant_type: "+grantType)
}

// NormalizeAndAssertScope 校验 scope 全部允许,返回去重后的有效 scope 字符串(clients.ts:80-92)。
func NormalizeAndAssertScope(c *OAuthClient, requested string) (string, error) {
	if requested == "" {
		return "", NewOAuthError(ErrInvalidScope, "scope 缺失")
	}
	allowed := map[string]bool{}
	for _, s := range c.AllowedScopes {
		allowed[s] = true
	}
	seen := map[string]bool{}
	var wanted []string
	for _, s := range splitSpaces(requested) {
		if !allowed[s] {
			return "", NewOAuthError(ErrInvalidScope, "不允许的 scope: "+s)
		}
		if !seen[s] {
			seen[s] = true
			wanted = append(wanted, s)
		}
	}
	return joinSpaces(wanted), nil
}
