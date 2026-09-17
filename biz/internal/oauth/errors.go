package oauth

import (
	"fmt"
	"net/http"
)

// errors.go:OAuth 标准错误,RFC 6749 §5.2(对齐 server/src/oauth/errors.ts)。

// OAuthErrorCode 错误码全集(errors.ts:5-15)。
type OAuthErrorCode string

const (
	ErrInvalidRequest          OAuthErrorCode = "invalid_request"
	ErrInvalidClient           OAuthErrorCode = "invalid_client"
	ErrInvalidGrant            OAuthErrorCode = "invalid_grant"
	ErrUnauthorizedClient      OAuthErrorCode = "unauthorized_client"
	ErrUnsupportedGrantType    OAuthErrorCode = "unsupported_grant_type"
	ErrUnsupportedResponseType OAuthErrorCode = "unsupported_response_type"
	ErrInvalidScope            OAuthErrorCode = "invalid_scope"
	ErrAccessDenied            OAuthErrorCode = "access_denied"
	ErrServerError             OAuthErrorCode = "server_error"
	ErrTemporarilyUnavailable  OAuthErrorCode = "temporarily_unavailable"
)

var httpStatusByCode = map[OAuthErrorCode]int{
	ErrInvalidRequest:          400,
	ErrInvalidClient:           401,
	ErrInvalidGrant:            400,
	ErrUnauthorizedClient:      400,
	ErrUnsupportedGrantType:    400,
	ErrUnsupportedResponseType: 400,
	ErrInvalidScope:            400,
	ErrAccessDenied:            403,
	ErrServerError:             500,
	ErrTemporarilyUnavailable:  503,
}

// OAuthError 标准错误(errors.ts:30-41)。
type OAuthError struct {
	Code        OAuthErrorCode
	Description string
}

func (e *OAuthError) Error() string { return string(e.Code) }

// Status HTTP 状态码。
func (e *OAuthError) Status() int { return httpStatusByCode[e.Code] }

// NewOAuthError 构造标准错误。
func NewOAuthError(code OAuthErrorCode, description string) *OAuthError {
	return &OAuthError{Code: code, Description: description}
}

// AsOAuthError 任意异常映射(errors.ts:52-55)。
func AsOAuthError(err error) *OAuthError {
	if oe, ok := err.(*OAuthError); ok {
		return oe
	}
	return NewOAuthError(ErrServerError, err.Error())
}

// BuildRedirectError 在 redirect_uri 回挂错误参数(errors.ts:58-68)。
func BuildRedirectError(redirectURI string, err *OAuthError, state string) string {
	u, perr := parseURL(redirectURI)
	if perr != nil {
		return redirectURI
	}
	q := u.Query()
	q.Set("error", string(err.Code))
	if err.Description != "" {
		q.Set("error_description", err.Description)
	}
	if state != "" {
		q.Set("state", state)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

var _ = fmt.Sprintf
var _ = http.StatusOK
