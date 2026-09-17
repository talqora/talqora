package api

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestSingleConvID(t *testing.T) {
	assert.Equal(t, "single_1_2", singleConvID(2, 1))
	assert.Equal(t, "single_1_2", singleConvID(1, 2))
	assert.Equal(t, "single_5_5", singleConvID(5, 5))
}

func TestParseNonneg(t *testing.T) {
	v, ok := parseNonneg("123")
	assert.True(t, ok)
	assert.Equal(t, int64(123), v)

	v, ok = parseNonneg(float64(7))
	assert.True(t, ok)
	assert.Equal(t, int64(7), v)

	_, ok = parseNonneg("-1")
	assert.False(t, ok)
	_, ok = parseNonneg("abc")
	assert.False(t, ok)
	_, ok = parseNonneg(float64(1.5))
	assert.False(t, ok)
	_, ok = parseNonneg(nil)
	assert.False(t, ok)
}

func TestRandomUUID(t *testing.T) {
	u1 := randomUUID()
	u2 := randomUUID()
	assert.Len(t, u1, 36)
	assert.NotEqual(t, u1, u2)
}

func TestParseStringArray(t *testing.T) {
	assert.Equal(t, []string{"a", "b"}, parseStringArray(`["a","b"]`))
	assert.Nil(t, parseStringArray("not-json"))
	assert.Empty(t, parseStringArray(`[]`))
}
