package oauth

import (
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

// tokens.go:AT/RT/ID Token 签发与验证,RS256 + go-jose(语义对齐 server/src/oauth/tokens.ts)。

// IssuerConfig issuer 与 TTL(tokens.ts:13-18)。
type IssuerConfig struct {
	Issuer   string
	ATTtlSec int
	RTTtlSec int
	IDTtlSec int
}

// ReadIssuerConfigFromEnv 构造 issuer 配置(tokens.ts:20-31)。
func ReadIssuerConfigFromEnv(issuerBaseURL string, atTTL, rtTTL, idTTL int) IssuerConfig {
	return IssuerConfig{
		Issuer:   issuerBaseURL,
		ATTtlSec: atTTL,
		RTTtlSec: rtTTL,
		IDTtlSec: idTTL,
	}
}

const (
	tokenAudienceAgentServer     = "agent-server"
	tokenAudienceRefreshEndpoint = "/oauth/token"
)

// scopeToAudience scope → resource server audience 映射(types.ts:120-122)。
var scopeToAudience = map[string]string{
	"agent-server": tokenAudienceAgentServer,
}

// DeriveAccessTokenAudience scope 里出现的 resource scope 才进 aud(tokens.ts:34-41)。
func DeriveAccessTokenAudience(scope string) []string {
	seen := map[string]bool{}
	var aud []string
	for _, s := range splitSpaces(scope) {
		if mapped, ok := scopeToAudience[s]; ok && !seen[mapped] {
			seen[mapped] = true
			aud = append(aud, mapped)
		}
	}
	return aud
}

// newSigner 用 active 私钥构造 RS256 signer(typ/kid 头对齐 Node jose SignJWT)。
func newSigner(store *KeyStore, typ string) (jose.Signer, error) {
	opts := (&jose.SignerOptions{}).WithType(jose.ContentType(typ)).WithHeader("kid", store.Active.Kid)
	return jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: store.Active.PrivateKey}, opts)
}

// signClaims 序列化 claims 并签名,返回 compact JWS。
func signClaims(store *KeyStore, typ string, claims map[string]any) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	signer, err := newSigner(store, typ)
	if err != nil {
		return "", err
	}
	obj, err := signer.Sign(payload)
	if err != nil {
		return "", err
	}
	return obj.CompactSerialize()
}

// SignAccessToken 签 access_token(tokens.ts:44-64)。
func SignAccessToken(store *KeyStore, cfg IssuerConfig, sub int64, scope, clientID, jti string) (string, int, error) {
	now := nowSec()
	claims := map[string]any{
		"iss":       cfg.Issuer,
		"sub":       fmt.Sprintf("%d", sub),
		"aud":       DeriveAccessTokenAudience(scope),
		"iat":       now,
		"exp":       now + int64(cfg.ATTtlSec),
		"scope":     scope,
		"client_id": clientID,
		"jti":       jti,
	}
	token, err := signClaims(store, "at+jwt", claims)
	return token, cfg.ATTtlSec, err
}

// SignRefreshToken 签 refresh_token,aud 锁定到 token 端点(tokens.ts:67-93)。
func SignRefreshToken(store *KeyStore, cfg IssuerConfig, sub int64, scope, clientID, jti, familyID string, expiresAt time.Time) (string, error) {
	now := nowSec()
	claims := map[string]any{
		"iss":       cfg.Issuer,
		"sub":       fmt.Sprintf("%d", sub),
		"aud":       []string{tokenAudienceRefreshEndpoint},
		"iat":       now,
		"exp":       expiresAt.Unix(),
		"scope":     scope,
		"client_id": clientID,
		"jti":       jti,
		"family_id": familyID,
	}
	return signClaims(store, "rt+jwt", claims)
}

// IDTokenProfile id_token 用户档案(tokens.ts:100-110 入参)。
type IDTokenProfile struct {
	Name              *string
	PreferredUsername *string
	Email             *string
	EmailVerified     bool
	Picture           *string
}

// SignIDToken 签 id_token,aud = client_id(tokens.ts:96-140)。
func SignIDToken(store *KeyStore, cfg IssuerConfig, sub int64, clientID string, authTime int64, nonce *string, scope string, profile IDTokenProfile) (string, error) {
	now := nowSec()
	scopes := splitSpacesSet(scope)
	claims := map[string]any{
		"iss":       cfg.Issuer,
		"sub":       fmt.Sprintf("%d", sub),
		"aud":       clientID,
		"iat":       now,
		"exp":       now + int64(cfg.IDTtlSec),
		"auth_time": authTime,
	}
	if nonce != nil {
		claims["nonce"] = *nonce
	}
	if scopes["profile"] {
		if profile.Name != nil {
			claims["name"] = *profile.Name
		}
		if profile.PreferredUsername != nil {
			claims["preferred_username"] = *profile.PreferredUsername
		}
		if profile.Picture != nil {
			claims["picture"] = *profile.Picture
		}
	}
	if scopes["email"] {
		if profile.Email != nil {
			claims["email"] = *profile.Email
		}
		claims["email_verified"] = profile.EmailVerified
	}
	return signClaims(store, "JWT", claims)
}

// verifyKeyByKid 按 kid 从密钥库选公钥。
func verifyKeyByKid(store *KeyStore, kid string) (*rsa.PublicKey, error) {
	k, ok := store.All[kid]
	if !ok {
		return nil, fmt.Errorf("unknown kid: %s", kid)
	}
	return k.PublicKey, nil
}

// verifySigned 验签 JWS 并校验 iss/exp(clockTolerance 30s,aud 可选),返回 claims map。
func verifySigned(store *KeyStore, cfg IssuerConfig, token string, audience string, withAud bool) (map[string]any, error) {
	obj, err := jose.ParseSigned(token, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil {
		return nil, err
	}
	if len(obj.Signatures) == 0 {
		return nil, fmt.Errorf("missing header")
	}
	kid := obj.Signatures[0].Header.KeyID
	pub, err := verifyKeyByKid(store, kid)
	if err != nil {
		return nil, err
	}
	payload, err := obj.Verify(pub)
	if err != nil {
		return nil, err
	}
	var claims map[string]any
	if err := jsonUnmarshal(payload, &claims); err != nil {
		return nil, err
	}
	// iss / exp / aud(clockTolerance 30s,tokens.ts:157-159)
	if claims["iss"] != cfg.Issuer {
		return nil, fmt.Errorf("issuer 不匹配")
	}
	exp, _ := claims["exp"].(float64)
	if exp == 0 || float64(nowSec()) > exp+30 {
		return nil, fmt.Errorf("token 已过期")
	}
	if withAud {
		if !audienceContains(claims["aud"], audience) {
			return nil, fmt.Errorf("audience 不匹配")
		}
	}
	return claims, nil
}

func audienceContains(aud any, want string) bool {
	switch t := aud.(type) {
	case string:
		return t == want
	case []any:
		for _, a := range t {
			if s, ok := a.(string); ok && s == want {
				return true
			}
		}
	}
	return false
}

// VerifyRefreshToken 验证 refresh_token(tokens.ts:144-165):失败统一 invalid_grant 语义由调用方处理。
func VerifyRefreshToken(store *KeyStore, cfg IssuerConfig, token string) (map[string]any, error) {
	return verifySigned(store, cfg, token, tokenAudienceRefreshEndpoint, true)
}

// VerifyAccessToken 验证 access_token(tokens.ts:168-188):失败返回 nil。
func VerifyAccessToken(store *KeyStore, cfg IssuerConfig, token string) (map[string]any, error) {
	return verifySigned(store, cfg, token, "", false)
}

func nowSec() int64 { return time.Now().Unix() }

// splitSpaces 空白切分 scope。
func splitSpaces(scope string) []string {
	return strings.Fields(scope)
}

// splitSpacesSet scope → set。
func splitSpacesSet(scope string) map[string]bool {
	out := map[string]bool{}
	for _, s := range strings.Fields(scope) {
		out[s] = true
	}
	return out
}
