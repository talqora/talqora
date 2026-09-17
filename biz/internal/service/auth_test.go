package service

import (
	"errors"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func nowMinus(sec int64) time.Time { return time.Now().Add(-time.Duration(sec) * time.Second) }

func TestSignVerifySessionToken(t *testing.T) {
	secret := []byte("test-secret")
	tok, err := SignSessionToken(secret, 42, "alice", "1h")
	require.NoError(t, err)

	claims, err := VerifySessionToken(secret, tok)
	require.NoError(t, err)
	assert.Equal(t, int64(42), claims.ID)
	assert.Equal(t, "alice", claims.Username)
}

func TestVerifySessionTokenWrongSecret(t *testing.T) {
	tok, err := SignSessionToken([]byte("a"), 1, "u", "1h")
	require.NoError(t, err)
	_, err = VerifySessionToken([]byte("b"), tok)
	require.Error(t, err)
}

func TestVerifySessionTokenExpired(t *testing.T) {
	// 直接构造已过期 token
	claims := AuthClaims{ID: 1, Username: "u"}
	claims.RegisteredClaims = jwt.RegisteredClaims{
		ExpiresAt: jwt.NewNumericDate(nowMinus(3600)),
		IssuedAt:  jwt.NewNumericDate(nowMinus(7200)),
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte("k"))
	require.NoError(t, err)
	_, err = VerifySessionToken([]byte("k"), tok)
	require.Error(t, err)
	assert.True(t, errors.Is(err, jwt.ErrTokenExpired))
}

func TestDecodeWithoutVerify(t *testing.T) {
	tok, err := SignSessionToken([]byte("k"), 7, "bob", "1h")
	require.NoError(t, err)
	claims, err := DecodeSessionTokenWithoutVerify(tok)
	require.NoError(t, err)
	assert.Equal(t, int64(7), claims.ID)
}

func TestHashComparePassword(t *testing.T) {
	hash, err := HashPassword("bench_pw_123456")
	require.NoError(t, err)
	assert.True(t, ComparePassword(hash, "bench_pw_123456"))
	assert.False(t, ComparePassword(hash, "wrong"))
}
