package oauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/service"
	"github.com/our-chat/biz/internal/store"
)

// handlers.go:8 个 OAuth 路由 handler(对齐 server/src/oauth/ 各端点)。

// OIDC scopes(types.ts:124)。
var oidcScopes = map[string]bool{"openid": true, "profile": true, "email": true}

// HandlerEnv 端点共享环境(store/issuer/codeTtl/loginPath)。
type HandlerEnv struct {
	Store      *KeyStore
	Issuer     IssuerConfig
	CodeTTLSec int
	LoginPath  string
	JWTSecret  []byte
}

// Mount 挂载全部 OAuth 路由(index.ts:22-44)。
func Mount(r *gin.Engine, env *HandlerEnv, tokenAuth gin.HandlerFunc) {
	r.GET("/.well-known/openid-configuration", makeDiscoveryHandler(env))
	r.GET("/.well-known/jwks.json", makeJwksHandler(env))
	g := r.Group("/oauth")
	g.GET("/authorize", makeAuthorizeHandler(env))
	g.POST("/token", makeTokenHandler(env))
	g.POST("/revoke", makeRevokeHandler(env))
	g.POST("/introspect", makeIntrospectHandler(env))
	g.GET("/userinfo", makeUserInfoHandler(env))
	g.POST("/agent-token", tokenAuth, makeAgentTokenHandler(env))
}

// ==================== discovery(discovery.ts) ====================

func makeDiscoveryHandler(env *HandlerEnv) gin.HandlerFunc {
	base := env.Issuer.Issuer
	body := map[string]any{
		"issuer":                                base,
		"authorization_endpoint":                base + "/oauth/authorize",
		"token_endpoint":                        base + "/oauth/token",
		"revocation_endpoint":                   base + "/oauth/revoke",
		"introspection_endpoint":                base + "/oauth/introspect",
		"userinfo_endpoint":                     base + "/oauth/userinfo",
		"jwks_uri":                              base + "/.well-known/jwks.json",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_basic", "none"},
		"code_challenge_methods_supported":      []string{"S256"},
		"scopes_supported":                      []string{"openid", "profile", "email", "agent-server"},
		"claims_supported": []string{"sub", "iss", "aud", "exp", "iat", "name", "email",
			"email_verified", "preferred_username", "picture"},
	}
	serialized, _ := json.Marshal(body)
	return func(c *gin.Context) {
		c.Header("Content-Type", "application/json")
		c.Header("Cache-Control", "public, max-age=3600")
		c.Data(http.StatusOK, "application/json", serialized)
	}
}

// ==================== jwks(jwks.ts) ====================

func makeJwksHandler(env *HandlerEnv) gin.HandlerFunc {
	serialized, _ := json.Marshal(BuildJwksResponse(env.Store))
	return func(c *gin.Context) {
		c.Header("Content-Type", "application/json")
		c.Header("Cache-Control", "public, max-age=600")
		c.Data(http.StatusOK, "application/json", serialized)
	}
}

// ==================== authorize(authorize.ts) ====================

func makeAuthorizeHandler(env *HandlerEnv) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		clientID := c.Query("client_id")
		redirectURI := c.Query("redirect_uri")
		state := c.Query("state")

		// 1. client_id + redirect_uri:任一失败 → 400 JSON,绝不重定向(防 open redirect)
		client, err := RequireActiveClient(ctx, clientID)
		if err != nil {
			auditParamInvalid(c, clientID, AsOAuthError(err).Code)
			sendOAuthErrorJSON(c, AsOAuthError(err))
			return
		}
		if err := AssertRedirectURIIsAllowed(client, redirectURI); err != nil {
			auditParamInvalid(c, clientID, AsOAuthError(err).Code)
			sendOAuthErrorJSON(c, AsOAuthError(err))
			return
		}
		if err := AssertGrantAllowed(client, "authorization_code"); err != nil {
			auditParamInvalid(c, clientID, AsOAuthError(err).Code)
			sendOAuthErrorJSON(c, AsOAuthError(err))
			return
		}

		// 2. 其余参数 → redirect 回带 error
		failRedirect := func(err *OAuthError) {
			Audit(map[string]any{
				"event":     map[bool]string{true: "internal_error", false: "param_invalid"}[err.Code == ErrServerError],
				"client_id": client.ClientID,
				"reason":    err.Code,
				"ip":        clientIP(c),
				"user_agent": c.GetHeader("User-Agent"),
			})
			c.Redirect(http.StatusFound, BuildRedirectError(redirectURI, err, state))
		}

		if c.Query("response_type") != "code" {
			failRedirect(NewOAuthError(ErrUnsupportedResponseType, "response_type 必须为 code"))
			return
		}
		if state == "" {
			failRedirect(NewOAuthError(ErrInvalidRequest, "state 缺失"))
			return
		}
		if client.RequirePkce {
			if c.Query("code_challenge") == "" {
				failRedirect(NewOAuthError(ErrInvalidRequest, "code_challenge 缺失"))
				return
			}
			if c.Query("code_challenge_method") != "S256" {
				failRedirect(NewOAuthError(ErrInvalidRequest, "code_challenge_method 必须为 S256"))
				return
			}
		}
		scope, err := NormalizeAndAssertScope(client, c.Query("scope"))
		if err != nil {
			failRedirect(AsOAuthError(err))
			return
		}
		// OIDC scope 时 nonce 强制
		isOidc := false
		for _, s := range splitSpaces(scope) {
			if oidcScopes[s] {
				isOidc = true
				break
			}
		}
		nonce := c.Query("nonce")
		if isOidc && nonce == "" {
			failRedirect(NewOAuthError(ErrInvalidRequest, "nonce 缺失(OIDC scope 强制)"))
			return
		}

		// 3. 校验登录态:读 our-chat HttpOnly token cookie(authorize.ts:68-81)
		sessionToken, err := c.Cookie("token")
		if err != nil || sessionToken == "" {
			next := url.QueryEscape(c.Request.URL.RequestURI())
			c.Redirect(http.StatusFound, env.LoginPath+"?next="+next)
			return
		}
		claims, err := service.VerifySessionToken(env.JWTSecret, sessionToken)
		if err != nil {
			next := url.QueryEscape(c.Request.URL.RequestURI())
			c.Redirect(http.StatusFound, env.LoginPath+"?next="+next)
			return
		}

		// 4. 生成 code 入库
		code, err := CreateCode(ctx, struct {
			ClientID            string
			UserID              int64
			RedirectURI         string
			CodeChallenge       string
			CodeChallengeMethod string
			Scope               string
			Nonce               *string
			TTLSec              int
		}{
			ClientID:            client.ClientID,
			UserID:              claims.ID,
			RedirectURI:         redirectURI,
			CodeChallenge:       c.Query("code_challenge"),
			CodeChallengeMethod: "S256",
			Scope:               scope,
			Nonce:               strPtrOrNil(nonce),
			TTLSec:              env.CodeTTLSec,
		})
		if err != nil {
			failRedirect(AsOAuthError(err))
			return
		}

		Audit(map[string]any{
			"event":     "code_issued",
			"client_id": client.ClientID,
			"user_id":   claims.ID,
			"scope":     scope,
			"ip":        clientIP(c),
			"user_agent": c.GetHeader("User-Agent"),
		})

		u, _ := url.Parse(redirectURI)
		q := u.Query()
		q.Set("code", code)
		q.Set("state", state)
		u.RawQuery = q.Encode()
		c.Redirect(http.StatusFound, u.String())
	}
}

// ==================== token(token.ts) ====================

func makeTokenHandler(env *HandlerEnv) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		var body map[string]any
		_ = c.ShouldBindJSON(&body)
		bodyStr := map[string]string{}
		for k, v := range body {
			if s, ok := v.(string); ok {
				bodyStr[k] = s
			}
		}
		grantType := bodyStr["grant_type"]

		// confidential client 支持 form body 与 Basic Auth(token.ts:46-52)
		basicClientID, basicSecret, hasBasic := parseBasicAuth(c)
		clientID := bodyStr["client_id"]
		clientSecretStr, hasSecret := bodyStr["client_secret"]
		if hasBasic {
			clientID = basicClientID
			clientSecretStr = basicSecret
			hasSecret = true
		}
		var clientSecret *string
		if hasSecret {
			clientSecret = &clientSecretStr
		}

		fail := func(err *OAuthError) {
			Audit(map[string]any{
				"event":      map[bool]string{true: "client_rejected", false: "grant_rejected"}[err.Code == ErrInvalidClient],
				"reason":     err.Code,
				"ip":         clientIP(c),
				"user_agent": c.GetHeader("User-Agent"),
			})
			sendOAuthErrorJSON(c, err)
		}

		client, err := RequireActiveClient(ctx, clientID)
		if err != nil {
			fail(AsOAuthError(err))
			return
		}
		if err := AuthenticateClient(client, clientSecret); err != nil {
			fail(AsOAuthError(err))
			return
		}

		switch grantType {
		case "authorization_code":
			if err := AssertGrantAllowed(client, "authorization_code"); err != nil {
				fail(AsOAuthError(err))
				return
			}
			handleAuthorizationCode(c, env, client, bodyStr)
		case "refresh_token":
			if err := AssertGrantAllowed(client, "refresh_token"); err != nil {
				fail(AsOAuthError(err))
				return
			}
			handleRefreshToken(c, env, client, bodyStr)
		default:
			fail(NewOAuthError(ErrUnsupportedGrantType, "grant_type="+grantType))
		}
	}
}

// handleAuthorizationCode authorization_code grant(token.ts:75-174)。
func handleAuthorizationCode(c *gin.Context, env *HandlerEnv, client *OAuthClient, body map[string]string) {
	ctx := c.Request.Context()
	codeStr := body["code"]
	redirectURI := body["redirect_uri"]
	verifier := body["code_verifier"]

	fail := func(err *OAuthError) {
		Audit(map[string]any{
			"event":      "grant_rejected",
			"reason":     err.Code,
			"client_id":  client.ClientID,
			"ip":         clientIP(c),
			"user_agent": c.GetHeader("User-Agent"),
		})
		sendOAuthErrorJSON(c, err)
	}

	if codeStr == "" {
		fail(NewOAuthError(ErrInvalidRequest, "code 缺失"))
		return
	}
	if redirectURI == "" {
		fail(NewOAuthError(ErrInvalidRequest, "redirect_uri 缺失"))
		return
	}
	code, err := ConsumeCode(ctx, codeStr)
	if err != nil {
		fail(NewOAuthError(ErrServerError, err.Error()))
		return
	}
	if code == nil {
		fail(NewOAuthError(ErrInvalidGrant, "code 不存在或已使用"))
		return
	}
	if code.ExpiresAt.Before(time.Now()) {
		fail(NewOAuthError(ErrInvalidGrant, "code 已过期"))
		return
	}
	if code.ClientID != client.ClientID {
		fail(NewOAuthError(ErrInvalidGrant, "code 不属于此 client"))
		return
	}
	if code.RedirectURI != redirectURI {
		fail(NewOAuthError(ErrInvalidGrant, "redirect_uri 与 authorize 时不一致"))
		return
	}
	if client.RequirePkce {
		if verifier == "" {
			fail(NewOAuthError(ErrInvalidGrant, "code_verifier 缺失"))
			return
		}
		if !VerifyS256(verifier, code.CodeChallenge) {
			fail(NewOAuthError(ErrInvalidGrant, "code_verifier 校验失败"))
			return
		}
	}

	profile := loadProfile(ctx, code.UserID)
	familyID := NewFamilyID()
	atJti := NewJti("at")
	rtJti := NewJti("rt")
	rtExpires := time.Now().Add(time.Duration(client.RefreshLifetimeSec) * time.Second)

	if err := InsertRefreshToken(ctx, rtJti, familyID, client.ClientID, code.UserID, code.Scope, rtExpires); err != nil {
		fail(NewOAuthError(ErrServerError, err.Error()))
		return
	}
	at, _, err := SignAccessToken(env.Store, env.Issuer, code.UserID, code.Scope, client.ClientID, atJti)
	if err != nil {
		fail(NewOAuthError(ErrServerError, err.Error()))
		return
	}
	rt, err := SignRefreshToken(env.Store, env.Issuer, code.UserID, code.Scope, client.ClientID, rtJti, familyID, rtExpires)
	if err != nil {
		fail(NewOAuthError(ErrServerError, err.Error()))
		return
	}

	wantsOidc := false
	for _, s := range splitSpaces(code.Scope) {
		if oidcScopes[s] {
			wantsOidc = true
			break
		}
	}
	resp := map[string]any{
		"access_token":  at,
		"token_type":    "Bearer",
		"expires_in":    env.Issuer.ATTtlSec,
		"refresh_token": rt,
		"scope":         code.Scope,
	}
	if wantsOidc {
		idToken, err := SignIDToken(env.Store, env.Issuer, code.UserID, client.ClientID,
			nowSec(), code.Nonce, code.Scope, profile)
		if err != nil {
			fail(NewOAuthError(ErrServerError, err.Error()))
			return
		}
		resp["id_token"] = idToken
	}

	Audit(map[string]any{
		"event":      "code_exchanged",
		"client_id":  client.ClientID,
		"user_id":    code.UserID,
		"new_rt_jti": rtJti,
		"scope":      code.Scope,
		"ip":         clientIP(c),
		"user_agent": c.GetHeader("User-Agent"),
	})
	noStoreJSON(c, resp)
}

// handleRefreshToken refresh_token grant(token.ts:176-296)。
func handleRefreshToken(c *gin.Context, env *HandlerEnv, client *OAuthClient, body map[string]string) {
	ctx := c.Request.Context()
	rt := body["refresh_token"]

	fail := func(err *OAuthError) {
		Audit(map[string]any{
			"event":      "grant_rejected",
			"reason":     err.Code,
			"client_id":  client.ClientID,
			"ip":         clientIP(c),
			"user_agent": c.GetHeader("User-Agent"),
		})
		sendOAuthErrorJSON(c, err)
	}

	if rt == "" {
		fail(NewOAuthError(ErrInvalidRequest, "refresh_token 缺失"))
		return
	}
	claims, err := VerifyRefreshToken(env.Store, env.Issuer, rt)
	if err != nil {
		fail(NewOAuthError(ErrInvalidGrant, "refresh_token 无效或已过期"))
		return
	}
	if claims["client_id"] != client.ClientID {
		fail(NewOAuthError(ErrInvalidGrant, "refresh_token 不属于此 client"))
		return
	}
	jti, _ := claims["jti"].(string)
	stored, err := FindRefreshToken(ctx, jti)
	if err != nil {
		fail(NewOAuthError(ErrServerError, err.Error()))
		return
	}
	if stored == nil {
		fail(NewOAuthError(ErrInvalidGrant, "refresh_token 不存在"))
		return
	}
	// reuse 检测(token.ts:199-211)
	if stored.Revoked || stored.RotatedTo != nil {
		_, _ = InvalidateFamily(ctx, stored.FamilyID, "reuse_detected")
		Audit(map[string]any{
			"event":      "rt_reuse_detected",
			"family_id":  stored.FamilyID,
			"old_rt_jti": stored.Jti,
			"user_id":    stored.UserID,
			"client_id":  client.ClientID,
			"ip":         clientIP(c),
			"user_agent": c.GetHeader("User-Agent"),
		})
		fail(NewOAuthError(ErrInvalidGrant, "refresh_token 已撤销或已被使用"))
		return
	}
	if stored.ExpiresAt.Before(time.Now()) {
		fail(NewOAuthError(ErrInvalidGrant, "refresh_token 已过期"))
		return
	}

	// scope 收缩(token.ts:216-228)
	scope := stored.Scope
	if requested, ok := body["scope"]; ok && requested != "" {
		normalized, err := NormalizeAndAssertScope(client, requested)
		if err != nil {
			fail(AsOAuthError(err))
			return
		}
		original := splitSpacesSet(stored.Scope)
		for _, s := range splitSpaces(normalized) {
			if !original[s] {
				fail(NewOAuthError(ErrInvalidScope, "scope 超出原范围: "+s))
				return
			}
		}
		scope = normalized
	}

	// 签发新 AT + 新 RT,再原子 rotation(token.ts:230-259)
	newRtJti := NewJti("rt")
	newAtJti := NewJti("at")
	newRtExpires := time.Now().Add(time.Duration(client.RefreshLifetimeSec) * time.Second)

	ok, err := tryRotateInTransaction(ctx, stored.Jti, newRtJti, stored.FamilyID, client.ClientID, stored.UserID, scope, newRtExpires)
	if err != nil {
		fail(NewOAuthError(ErrServerError, err.Error()))
		return
	}
	if !ok {
		_, _ = InvalidateFamily(ctx, stored.FamilyID, "reuse_detected")
		Audit(map[string]any{
			"event":      "rt_reuse_detected",
			"family_id":  stored.FamilyID,
			"old_rt_jti": stored.Jti,
			"user_id":    stored.UserID,
			"client_id":  client.ClientID,
			"reason":     "concurrent_rotation",
			"ip":         clientIP(c),
			"user_agent": c.GetHeader("User-Agent"),
		})
		fail(NewOAuthError(ErrInvalidGrant, "refresh_token 已被使用"))
		return
	}

	at, _, err := SignAccessToken(env.Store, env.Issuer, stored.UserID, scope, client.ClientID, newAtJti)
	if err != nil {
		fail(NewOAuthError(ErrServerError, err.Error()))
		return
	}
	newRt, err := SignRefreshToken(env.Store, env.Issuer, stored.UserID, scope, client.ClientID, newRtJti, stored.FamilyID, newRtExpires)
	if err != nil {
		fail(NewOAuthError(ErrServerError, err.Error()))
		return
	}

	Audit(map[string]any{
		"event":      "token_refreshed",
		"family_id":  stored.FamilyID,
		"old_rt_jti": stored.Jti,
		"new_rt_jti": newRtJti,
		"client_id":  client.ClientID,
		"user_id":    stored.UserID,
		"ip":         clientIP(c),
		"user_agent": c.GetHeader("User-Agent"),
	})
	noStoreJSON(c, map[string]any{
		"access_token":  at,
		"token_type":    "Bearer",
		"expires_in":    env.Issuer.ATTtlSec,
		"refresh_token": newRt,
		"scope":         scope,
	})
}

// tryRotateInTransaction 事务保证 rotation + insert 原子(token.ts:300-338)。
func tryRotateInTransaction(ctx context.Context, oldJti, newJti, familyID, clientID string, userID int64, scope string, expiresAt time.Time) (bool, error) {
	tx, err := store.PG().Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `
		INSERT INTO oauth_refresh_tokens (jti, family_id, client_id, user_id, scope, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		newJti, familyID, clientID, userID, scope, expiresAt); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE oauth_refresh_tokens SET rotated_to = $2, rotated_at = now(), revoke_reason = 'rotation'
		WHERE jti = $1 AND rotated_to IS NULL AND revoked = false`, oldJti, newJti)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() != 1 {
		return false, nil // 并发被抢:回滚 INSERT,上层触发 family invalidate
	}
	return true, tx.Commit(ctx)
}

// ==================== revoke(revoke.ts,RFC 7009) ====================

func makeRevokeHandler(env *HandlerEnv) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		var body map[string]string
		_ = c.ShouldBindJSON(&body)

		client, err := RequireActiveClient(ctx, body["client_id"])
		if err != nil {
			sendOAuthErrorJSON(c, AsOAuthError(err))
			return
		}
		secret := body["client_secret"]
		var secretPtr *string
		if secret != "" {
			secretPtr = &secret
		}
		if err := AuthenticateClient(client, secretPtr); err != nil {
			sendOAuthErrorJSON(c, AsOAuthError(err))
			return
		}
		token := body["token"]
		hint := body["token_type_hint"]
		if token == "" {
			c.Status(http.StatusOK) // RFC 7009 §2.2:token 缺失也 200(防探测)
			return
		}
		if hint != "access_token" {
			claims, err := VerifyRefreshToken(env.Store, env.Issuer, token)
			if err == nil && claims["client_id"] == client.ClientID {
				jti, _ := claims["jti"].(string)
				if revoked, err := RevokeRefreshTokenByJti(ctx, jti, "logout"); err == nil && revoked {
					Audit(map[string]any{
						"event":     "token_revoked",
						"jti":       jti,
						"user_id":   claims["sub"],
						"client_id": client.ClientID,
						"reason":    "logout",
						"ip":        clientIP(c),
						"user_agent": c.GetHeader("User-Agent"),
					})
				}
			}
		}
		c.Status(http.StatusOK)
	}
}

// ==================== introspect(introspect.ts,RFC 7662) ====================

func makeIntrospectHandler(env *HandlerEnv) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		var body map[string]string
		_ = c.ShouldBindJSON(&body)

		client, err := RequireActiveClient(ctx, body["client_id"])
		if err != nil {
			sendOAuthErrorJSON(c, AsOAuthError(err))
			return
		}
		if client.ClientType != "confidential" {
			sendOAuthErrorJSON(c, NewOAuthError(ErrInvalidClient, "仅 confidential client 可调用 introspect"))
			return
		}
		secret := body["client_secret"]
		var secretPtr *string
		if secret != "" {
			secretPtr = &secret
		}
		if err := AuthenticateClient(client, secretPtr); err != nil {
			sendOAuthErrorJSON(c, AsOAuthError(err))
			return
		}
		token := body["token"]
		if token == "" {
			c.JSON(http.StatusOK, gin.H{"active": false})
			return
		}
		tryOrder := []string{"access_token", "refresh_token"}
		if body["token_type_hint"] == "refresh_token" {
			tryOrder = []string{"refresh_token", "access_token"}
		}
		for _, kind := range tryOrder {
			if kind == "access_token" {
				claims, err := VerifyAccessToken(env.Store, env.Issuer, token)
				if err == nil && claims != nil {
					c.JSON(http.StatusOK, introspectResponse(claims, "Bearer"))
					return
				}
			} else {
				claims, err := VerifyRefreshToken(env.Store, env.Issuer, token)
				if err != nil {
					continue
				}
				jti, _ := claims["jti"].(string)
				stored, err := FindRefreshToken(ctx, jti)
				if err == nil && stored != nil && !stored.Revoked && stored.RotatedTo == nil &&
					stored.ExpiresAt.After(time.Now()) {
					c.JSON(http.StatusOK, introspectResponse(claims, "refresh_token"))
					return
				}
			}
		}
		c.JSON(http.StatusOK, gin.H{"active": false})
	}
}

func introspectResponse(claims map[string]any, tokenType string) gin.H {
	return gin.H{
		"active":     true,
		"token_type": tokenType,
		"scope":      claims["scope"],
		"client_id":  claims["client_id"],
		"sub":        claims["sub"],
		"aud":        claims["aud"],
		"iss":        claims["iss"],
		"exp":        claims["exp"],
		"iat":        claims["iat"],
		"jti":        claims["jti"],
	}
}

// ==================== userinfo(userinfo.ts,OIDC Core 1.0) ====================

func makeUserInfoHandler(env *HandlerEnv) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx := c.Request.Context()
		h := c.GetHeader("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			sendOAuthErrorJSON(c, NewOAuthError(ErrInvalidRequest, "缺少 Bearer token"))
			return
		}
		at := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
		claims, err := VerifyAccessToken(env.Store, env.Issuer, at)
		if err != nil || claims == nil {
			sendOAuthErrorJSON(c, NewOAuthError(ErrInvalidGrant, "access_token 无效"))
			return
		}
		scopes := splitSpacesSet(stringOf(claims["scope"]))
		if !scopes["openid"] {
			sendOAuthErrorJSON(c, NewOAuthError(ErrInvalidRequest, "access_token 未授予 openid scope"))
			return
		}
		sub, _ := strconv.ParseInt(stringOf(claims["sub"]), 10, 64)
		user, err := findUserProfile(ctx, sub)
		if err != nil || user == nil {
			sendOAuthErrorJSON(c, NewOAuthError(ErrInvalidGrant, "用户不存在"))
			return
		}
		body := gin.H{"sub": strconv.FormatInt(user.ID, 10)}
		if scopes["profile"] {
			name := ""
			if user.Nickname != nil {
				name = *user.Nickname
			} else {
				name = user.Username
			}
			body["name"] = name
			body["preferred_username"] = user.Username
			body["picture"] = user.Avatar
		}
		if scopes["email"] {
			body["email"] = user.Email
			body["email_verified"] = false
		}
		c.JSON(http.StatusOK, body)
	}
}

// ==================== agent-token(agentToken.ts) ====================

const agentScope = "agent-server"

func makeAgentTokenHandler(env *HandlerEnv) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := sessionUserID(c)
		if userID == 0 {
			c.JSON(http.StatusUnauthorized, gin.H{"success": false, "message": "未登录"})
			return
		}
		at, _, err := SignAccessToken(env.Store, env.Issuer, userID, agentScope, "our-chat-web", NewJti("at"))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "agent-token 铸造失败"})
			return
		}
		Audit(map[string]any{
			"event":     "agent_token_issued",
			"client_id": "our-chat-web",
			"user_id":   userID,
			"scope":     agentScope,
			"ip":        clientIP(c),
			"user_agent": c.GetHeader("User-Agent"),
		})
		c.Header("Cache-Control", "no-store")
		c.Header("Pragma", "no-cache")
		c.JSON(http.StatusOK, gin.H{
			"access_token": at,
			"token_type":   "Bearer",
			"expires_in":   env.Issuer.ATTtlSec,
		})
	}
}

// ---- helpers ----

func sendOAuthErrorJSON(c *gin.Context, err *OAuthError) {
	c.JSON(err.Status(), gin.H{"error": string(err.Code), "error_description": err.Description})
}

func noStoreJSON(c *gin.Context, body any) {
	c.Header("Cache-Control", "no-store")
	c.Header("Pragma", "no-cache")
	c.JSON(http.StatusOK, body)
}

func parseBasicAuth(c *gin.Context) (clientID, secret string, ok bool) {
	h := c.GetHeader("Authorization")
	if !strings.HasPrefix(h, "Basic ") {
		return "", "", false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(strings.TrimPrefix(h, "Basic ")))
	if err != nil {
		return "", "", false
	}
	idx := strings.Index(string(decoded), ":")
	if idx < 0 {
		return "", "", false
	}
	return string(decoded[:idx]), string(decoded[idx+1:]), true
}

func auditParamInvalid(c *gin.Context, clientID string, reason OAuthErrorCode) {
	Audit(map[string]any{
		"event":      "param_invalid",
		"client_id":  clientID,
		"reason":     reason,
		"ip":         clientIP(c),
		"user_agent": c.GetHeader("User-Agent"),
	})
}

func clientIP(c *gin.Context) string {
	xff := c.GetHeader("X-Forwarded-For")
	if xff != "" {
		if i := strings.Index(xff, ","); i > 0 {
			xff = xff[:i]
		}
		if ip := strings.TrimSpace(xff); ip != "" {
			return ip
		}
	}
	if ip := c.ClientIP(); ip != "" {
		return ip
	}
	return "unknown"
}

// loadProfile 用户档案(token.ts:341-359)。
func loadProfile(ctx context.Context, userID int64) IDTokenProfile {
	u, _ := findUserProfile(ctx, userID)
	if u == nil {
		return IDTokenProfile{EmailVerified: false}
	}
	return IDTokenProfile{
		Name:              u.Nickname,
		PreferredUsername: &u.Username,
		Email:             u.Email,
		EmailVerified:     false,
		Picture:           u.Avatar,
	}
}

type userProfileRow struct {
	ID       int64
	Username string
	Nickname *string
	Email    *string
	Avatar   *string
}

func findUserProfile(ctx context.Context, userID int64) (*userProfileRow, error) {
	var u userProfileRow
	err := store.PG().QueryRow(ctx, `
		SELECT id, username, nickname, email, avatar FROM users WHERE id = $1`, userID,
	).Scan(&u.ID, &u.Username, &u.Nickname, &u.Email, &u.Avatar)
	if isNoRowsErr(err) {
		return nil, nil
	}
	return &u, err
}

// sessionUserID 从 gin 上下文取登录用户(agent-token 挂在 authenticateToken 后)。
func sessionUserID(c *gin.Context) int64 {
	if v, ok := c.Get("user"); ok {
		if u, ok := v.(*service.UserProfile); ok {
			return u.ID
		}
	}
	return 0
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func stringOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

var _ = config.Config{}
