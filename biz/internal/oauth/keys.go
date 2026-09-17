// Package oauth 是 OAuth2.1/OIDC IdP(自研流程,语义对齐 server/src/oauth/)。
//
// 密码学选型偏离说明(报告记录):选型报告定稿 lestrrat-go/jwx/v4,但 jwx v4 全版本
// (v4.0.0~v4.5.0)无条件依赖 Go 1.26 实验包 encoding/json/v2(需 GOEXPERIMENT=jsonv2
// 才能编译,默认 Go 工具链构建失败),属硬性构建阻塞;故按选型报告 §2.6 的备选切换
// go-jose/v4(标准 encoding/json、fosite 底层、久经考验)。API 语义与 Node jose 对齐。
package oauth

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	jose "github.com/go-jose/go-jose/v4"
)

// SigningKey 签名密钥(keys.ts:9-15)。
type SigningKey struct {
	Kid        string
	PrivateKey *rsa.PrivateKey // 签发
	PublicKey  *rsa.PublicKey  // 验签(由私钥派生)
	PublicJWK  map[string]any
}

// KeyStore 密钥库(keys.ts:17-20)。
type KeyStore struct {
	Active *SigningKey
	All    map[string]*SigningKey
}

// LoadOptions 装载选项(keys.ts:22-27)。
type LoadOptions struct {
	ActiveKid      string
	RetiredKids    []string
	KeyDir         string
	PrivateKeyFile string
}

func loadOne(kid, file string) (*SigningKey, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("oauth-keys: 读 %s 失败: %w", file, err)
	}
	if !strings.Contains(string(data), "PRIVATE KEY") {
		return nil, fmt.Errorf("oauth-keys: %s 不是 PKCS#8 PEM 私钥", file)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("oauth-keys: %s PEM 解析失败", file)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("oauth-keys: %s PKCS#8 解析失败: %w", file, err)
	}
	priv, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("oauth-keys: %s 不是 RSA 私钥", kid)
	}
	pub := &priv.PublicKey

	// 模数 ≥2048 校验(keys.ts:46-49)
	if bits := pub.N.BitLen(); bits < 2048 {
		return nil, fmt.Errorf("oauth-keys: %s 模数 %d 位,不满足 ≥ 2048", kid, bits)
	}

	// 公钥 JWK(keys.ts:51-58:kty/n/e + alg/use/kid)
	jwks := jose.JSONWebKey{Key: pub, Algorithm: "RS256", Use: "sig", KeyID: kid}
	pubJWK, err := jwks.Public().MarshalJSON()
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := jsonUnmarshal(pubJWK, &m); err != nil {
		return nil, err
	}
	if m["kty"] != "RSA" || m["n"] == "" {
		return nil, fmt.Errorf("oauth-keys: %s 不是 RSA 公钥", kid)
	}
	publicJWK := map[string]any{
		"kty": m["kty"],
		"n":   m["n"],
		"e":   m["e"],
		"alg": "RS256",
		"use": "sig",
		"kid": kid,
	}
	return &SigningKey{Kid: kid, PrivateKey: priv, PublicKey: pub, PublicJWK: publicJWK}, nil
}

func resolveFile(opts *LoadOptions, kid string) string {
	if opts.PrivateKeyFile != "" && kid == opts.ActiveKid {
		return opts.PrivateKeyFile
	}
	if opts.KeyDir == "" {
		return ""
	}
	return filepath.Join(opts.KeyDir, "oauth-private-"+kid+".pem")
}

// LoadKeyStore 装载密钥库(keys.ts:73-82)。
func LoadKeyStore(opts *LoadOptions) (*KeyStore, error) {
	all := map[string]*SigningKey{}
	file := resolveFile(opts, opts.ActiveKid)
	if file == "" {
		return nil, fmt.Errorf("oauth-keys: 未配置 OAUTH_KEY_DIR,无法加载 kid=%s", opts.ActiveKid)
	}
	active, err := loadOne(opts.ActiveKid, file)
	if err != nil {
		return nil, err
	}
	all[active.Kid] = active
	for _, kid := range opts.RetiredKids {
		k, err := loadOne(kid, resolveFile(opts, kid))
		if err != nil {
			return nil, err
		}
		all[k.Kid] = k
	}
	return &KeyStore{Active: active, All: all}, nil
}

// BuildJwksResponse JWKS 响应(keys.ts:84-86)。
func BuildJwksResponse(store *KeyStore) map[string]any {
	keys := make([]map[string]any, 0, len(store.All))
	for _, k := range store.All {
		keys = append(keys, k.PublicJWK)
	}
	return map[string]any{"keys": keys}
}

// ReadKeyOptionsFromEnv 从 env 读取装载选项(keys.ts:88-103;OAUTH_ACTIVE_KID 缺失 fail-fast)。
func ReadKeyOptionsFromEnv() (*LoadOptions, error) {
	activeKid := os.Getenv("OAUTH_ACTIVE_KID")
	if activeKid == "" {
		return nil, fmt.Errorf("oauth-keys: 缺少 OAUTH_ACTIVE_KID")
	}
	var retired []string
	for _, s := range strings.Split(os.Getenv("OAUTH_RETIRED_KIDS"), ",") {
		if t := strings.TrimSpace(s); t != "" {
			retired = append(retired, t)
		}
	}
	return &LoadOptions{
		ActiveKid:      activeKid,
		RetiredKids:    retired,
		KeyDir:         os.Getenv("OAUTH_KEY_DIR"),
		PrivateKeyFile: os.Getenv("OAUTH_PRIVATE_KEY_FILE"),
	}, nil
}
