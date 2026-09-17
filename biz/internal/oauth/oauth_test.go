package oauth

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

func hashPasswordForTest(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), 12)
	return string(b), err
}

// genTestKey 生成 2048 位 RSA 私钥并写 PKCS#8 PEM 文件。
func genTestKey(t *testing.T, dir string) (*rsa.PrivateKey, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	der, err := x509.MarshalPKCS8PrivateKey(key)
	require.NoError(t, err)
	file := filepath.Join(dir, "oauth-private-dev.pem")
	require.NoError(t, os.WriteFile(file, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600))
	return key, file
}

func newTestStore(t *testing.T) (*KeyStore, string) {
	t.Helper()
	dir := t.TempDir()
	_, file := genTestKey(t, dir)
	store, err := LoadKeyStore(&LoadOptions{ActiveKid: "dev", PrivateKeyFile: file})
	require.NoError(t, err)
	return store, file
}

// TestLoadKeyStoreAndJwks 密钥装载 + JWKS 结构(≥2048 校验、kid/alg/use)。
func TestLoadKeyStoreAndJwks(t *testing.T) {
	store, _ := newTestStore(t)
	require.NotNil(t, store.Active)
	jwks := BuildJwksResponse(store)
	keys := jwks["keys"].([]map[string]any)
	require.Len(t, keys, 1)
	k := keys[0]
	assert.Equal(t, "RSA", k["kty"])
	assert.Equal(t, "RS256", k["alg"])
	assert.Equal(t, "sig", k["use"])
	assert.Equal(t, "dev", k["kid"])
	assert.NotEmpty(t, k["n"])
	assert.NotEmpty(t, k["e"])
}

// TestLoadKeyStoreInvalidPEM 非 PEM 文件 fail-fast。
func TestLoadKeyStoreInvalidPEM(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "bad.pem")
	require.NoError(t, os.WriteFile(file, []byte("not a key"), 0o600))
	_, err := LoadKeyStore(&LoadOptions{ActiveKid: "dev", PrivateKeyFile: file})
	require.Error(t, err)
}

// TestPKCE PKCE S256 校验往返。
func TestPKCE(t *testing.T) {
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" // RFC 7636 附录示例
	assert.True(t, IsValidVerifier(verifier))
	assert.False(t, IsValidVerifier("too-short"))
	challenge := DeriveS256Challenge(verifier)
	assert.Equal(t, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", challenge)
	assert.True(t, VerifyS256(verifier, challenge))
	assert.False(t, VerifyS256(verifier, "wrong"))
}

// TestSignVerifyAccessToken AT 签发→验证往返(iss/exp/kid 选钥)。
func TestSignVerifyAccessToken(t *testing.T) {
	store, _ := newTestStore(t)
	cfg := ReadIssuerConfigFromEnv("http://localhost:3007", 900, 2592000, 900)

	token, expiresIn, err := SignAccessToken(store, cfg, 42, "openid agent-server", "our-chat-web", "at-1")
	require.NoError(t, err)
	assert.Equal(t, 900, expiresIn)

	claims, err := VerifyAccessToken(store, cfg, token)
	require.NoError(t, err)
	assert.Equal(t, "42", claims["sub"])
	assert.Equal(t, "our-chat-web", claims["client_id"])
	aud := claims["aud"].([]any)
	assert.Contains(t, aud, "agent-server")

	// 错误 issuer 验证失败
	badCfg := cfg
	badCfg.Issuer = "http://evil"
	_, err = VerifyAccessToken(store, badCfg, token)
	require.Error(t, err)
}

// TestSignVerifyRefreshToken RT 签发→验证(锁 audience;篡改失败)。
func TestSignVerifyRefreshToken(t *testing.T) {
	store, _ := newTestStore(t)
	cfg := ReadIssuerConfigFromEnv("http://localhost:3007", 900, 2592000, 900)

	expiresAt := time.Now().Add(time.Hour)
	rt, err := SignRefreshToken(store, cfg, 7, "openid", "our-chat-web", "rt-1", "fam-1", expiresAt)
	require.NoError(t, err)

	claims, err := VerifyRefreshToken(store, cfg, rt)
	require.NoError(t, err)
	assert.Equal(t, "rt-1", claims["jti"])
	assert.Equal(t, "fam-1", claims["family_id"])

	// 过期 RT 验证失败
	expiredAt := time.Now().Add(-time.Hour)
	rt2, err := SignRefreshToken(store, cfg, 7, "openid", "our-chat-web", "rt-2", "fam-1", expiredAt)
	require.NoError(t, err)
	_, err = VerifyRefreshToken(store, cfg, rt2)
	require.Error(t, err)
}

// TestSignIDToken ID token:profile/email scope 才带对应 claims。
func TestSignIDToken(t *testing.T) {
	store, _ := newTestStore(t)
	cfg := ReadIssuerConfigFromEnv("http://localhost:3007", 900, 2592000, 900)
	name := "涂将"
	id, err := SignIDToken(store, cfg, 1, "our-chat-web", nowSec(), nil, "openid profile", IDTokenProfile{
		Name:              &name,
		PreferredUsername: nil,
	})
	require.NoError(t, err)
	claims, err := VerifyAccessToken(store, cfg, id)
	require.NoError(t, err)
	assert.Equal(t, "our-chat-web", claims["aud"])
	assert.Equal(t, name, claims["name"])
	assert.NotContains(t, claims, "email")
}

// TestVerifyS256ChallengeAndClientScope 客户端 scope 校验。
func TestNormalizeAndAssertScope(t *testing.T) {
	c := &OAuthClient{AllowedScopes: []string{"openid", "profile", "email", "agent-server"}}
	scope, err := NormalizeAndAssertScope(c, "openid profile openid")
	require.NoError(t, err)
	assert.Equal(t, "openid profile", scope)

	_, err = NormalizeAndAssertScope(c, "openid admin")
	require.Error(t, err)
	assert.Equal(t, ErrInvalidScope, AsOAuthError(err).Code)

	_, err = NormalizeAndAssertScope(c, "")
	require.Error(t, err)
}

// TestAuthenticateClient public 不允许带 secret;confidential 必须 bcrypt 匹配。
func TestAuthenticateClient(t *testing.T) {
	pub := &OAuthClient{ClientType: "public"}
	assert.NoError(t, AuthenticateClient(pub, nil))
	anySecret := "s"
	assert.Error(t, AuthenticateClient(pub, &anySecret))

	hash, err := hashPasswordForTest("client-secret")
	require.NoError(t, err)
	conf := &OAuthClient{ClientType: "confidential", ClientSecretHash: &hash}
	assert.Error(t, AuthenticateClient(conf, nil))
	good := "client-secret"
	assert.NoError(t, AuthenticateClient(conf, &good))
	bad := "wrong"
	assert.Error(t, AuthenticateClient(conf, &bad))
}

func TestBuildRedirectError(t *testing.T) {
	out := BuildRedirectError("https://app.example.com/cb?x=1", NewOAuthError(ErrInvalidRequest, "state 缺失"), "st-1")
	assert.Contains(t, out, "error=invalid_request")
	assert.Contains(t, out, "state=st-1")
	assert.Contains(t, out, "error_description=state+%E7%BC%BA%E5%A4%B1")
}
