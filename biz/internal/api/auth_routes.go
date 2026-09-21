package api

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"log/slog"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/our-chat/biz/internal/config"
	"github.com/our-chat/biz/internal/service"
	"github.com/our-chat/biz/internal/store"
)

// mountAuthRoutes 挂载 /api 面的认证与注册路由(app.ts:91-95:registerRouter/loginRouter/turnRouter)。
func mountAuthRoutes(r *gin.Engine, cfg *config.Config) {
	initAuthConfig(cfg)
	g := r.Group("/api")
	g.POST("/register", handleRegister)
	g.GET("/check-username", handleCheckUsername)
	g.GET("/check-email", handleCheckEmail)
	g.GET("/check-phone", handleCheckPhone)
	g.POST("/login", handleLogin)
	g.POST("/refresh", handleRefresh)
	g.POST("/logout", handleLogout)
	g.GET("/turn-credentials", AuthenticateToken(), handleTurnCredentials)
}

// ==================== 注册(register.ts:8-114) ====================

var (
	emailRe    = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	phoneRe    = regexp.MustCompile(`^1[3-9]\d{9}$`)
	usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_一-龥]+$`)
)

// registerBody 入参(可选字段原样透传)。
type registerBody struct {
	Username string `json:"username"`
	Email    string `json:"email"`
	Password string `json:"password"`
	Phone    string `json:"phone"`
	Nickname string `json:"nickname"`
	Avatar   string `json:"avatar"`
	Bio      string `json:"bio"`
}

func handleRegister(c *gin.Context) {
	var b registerBody
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "服务器内部错误"})
		return
	}

	// 校验顺序与文案逐条对齐 register.ts:12-46
	switch {
	case b.Username == "" || b.Email == "" || b.Password == "":
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "用户名、邮箱和密码不能为空"})
		return
	case len(b.Username) < 2 || len(b.Username) > 50:
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "用户名长度必须在2-50个字符之间"})
		return
	case len(b.Email) > 100:
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "邮箱地址不能超过100个字符"})
		return
	case len(b.Password) < 6 || len(b.Password) > 255:
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "密码长度必须在6-255个字符之间"})
		return
	case b.Phone != "" && len(b.Phone) > 20:
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "手机号码不能超过20个字符"})
		return
	case b.Nickname != "" && len(b.Nickname) > 50:
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "昵称不能超过50个字符"})
		return
	case b.Avatar != "" && len(b.Avatar) > 255:
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "头像URL不能超过255个字符"})
		return
	case !emailRe.MatchString(b.Email):
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "邮箱格式不正确"})
		return
	case b.Phone != "" && !phoneRe.MatchString(b.Phone):
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "手机号格式不正确"})
		return
	case !usernameRe.MatchString(b.Username):
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "用户名只能包含字母、数字、下划线和中文"})
		return
	}

	// 三个唯一字段冲突单独提示(register.ts:49-57)
	if exists, err := userExistsBy(c, "username", b.Username); err != nil {
		serverError(c)
		return
	} else if exists {
		c.JSON(http.StatusConflict, gin.H{"success": false, "message": "用户名已存在"})
		return
	}
	if exists, err := userExistsBy(c, "email", b.Email); err != nil {
		serverError(c)
		return
	} else if exists {
		c.JSON(http.StatusConflict, gin.H{"success": false, "message": "邮箱已被注册"})
		return
	}
	if b.Phone != "" {
		if exists, err := userExistsBy(c, "phone", b.Phone); err != nil {
			serverError(c)
			return
		} else if exists {
			c.JSON(http.StatusConflict, gin.H{"success": false, "message": "手机号已被注册"})
			return
		}
	}

	hashed, err := service.HashPassword(b.Password)
	if err != nil {
		serverError(c)
		return
	}
	nickname := b.Nickname
	if nickname == "" {
		nickname = b.Username
	}

	var (
		id        int64
		username  string
		email     string
		phone     *string
		status    string
		createdAt service.JSONTime
		insertErr error
	)
	var phoneVal any
	if b.Phone == "" {
		phoneVal = nil
	} else {
		phoneVal = b.Phone
	}
	insertErr = store.PG().QueryRow(c.Request.Context(), `
		INSERT INTO users (username, email, phone, password, nickname, avatar, bio, status, last_seen)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'online', now())
		RETURNING id, username, email, phone, status, created_at`,
		b.Username, b.Email, phoneVal, hashed, nickname, b.Avatar, b.Bio,
	).Scan(&id, &username, &email, &phone, &status, &createdAt.Time)
	if insertErr != nil {
		// 唯一约束兜底(并发预检 race,register.ts:102-111):409
		if isUniqueViolation(insertErr) {
			c.JSON(http.StatusConflict, gin.H{
				"success": false,
				"message": "用户信息已存在，请检查用户名、邮箱或手机号",
			})
			return
		}
		serverError(c)
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"success": true,
		"message": "注册成功",
		"data": gin.H{
			"id":        id,
			"username":  username,
			"email":     email,
			"phone":     phone,
			"nickname":  nickname,
			"avatar":    b.Avatar,
			"bio":       b.Bio,
			"status":    status,
			"createdAt": createdAt,
		},
	})
}

// ==================== 唯一性检查(register.ts:116-182) ====================

func handleCheckUsername(c *gin.Context) {
	username := c.Query("username")
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"exists": false, "message": "用户名不能为空"})
		return
	}
	if len(username) < 2 || len(username) > 50 {
		c.JSON(http.StatusOK, gin.H{"exists": false, "message": "用户名长度必须在2-50个字符之间"})
		return
	}
	exists, err := userExistsBy(c, "username", username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"exists": false, "message": "服务器错误"})
		return
	}
	msg := "用户名可用"
	if exists {
		msg = "用户名已存在"
	}
	c.JSON(http.StatusOK, gin.H{"exists": exists, "message": msg})
}

func handleCheckEmail(c *gin.Context) {
	email := c.Query("email")
	if email == "" {
		c.JSON(http.StatusBadRequest, gin.H{"exists": false, "message": "邮箱不能为空"})
		return
	}
	if len(email) > 100 {
		c.JSON(http.StatusOK, gin.H{"exists": false, "message": "邮箱地址不能超过100个字符"})
		return
	}
	if !emailRe.MatchString(email) {
		c.JSON(http.StatusOK, gin.H{"exists": false, "message": "邮箱格式不正确"})
		return
	}
	exists, err := userExistsBy(c, "email", email)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"exists": false, "message": "服务器错误"})
		return
	}
	msg := "邮箱可用"
	if exists {
		msg = "邮箱已被注册"
	}
	c.JSON(http.StatusOK, gin.H{"exists": exists, "message": msg})
}

func handleCheckPhone(c *gin.Context) {
	phone := c.Query("phone")
	if strings.TrimSpace(phone) == "" {
		phone = ""
	}
	if phone == "" {
		c.JSON(http.StatusBadRequest, gin.H{"exists": false, "message": "手机号不能为空"})
		return
	}
	if !phoneRe.MatchString(phone) {
		c.JSON(http.StatusOK, gin.H{"exists": false, "message": "手机号格式不正确"})
		return
	}
	exists, err := userExistsBy(c, "phone", phone)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"exists": false, "message": "服务器错误"})
		return
	}
	msg := "手机号可用"
	if exists {
		msg = "手机号已被注册"
	}
	c.JSON(http.StatusOK, gin.H{"exists": exists, "message": msg})
}

// userExistsBy 唯一性查询(列名白名单内,由调用方保证)。
func userExistsBy(c *gin.Context, col, val string) (bool, error) {
	var one int64
	err := store.RO().QueryRow(c.Request.Context(),
		"SELECT id FROM users WHERE "+col+" = $1", val).Scan(&one)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ==================== 登录(login.ts:17-51) ====================

type loginBody struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Remember bool   `json:"remember"`
}

func handleLogin(c *gin.Context) {
	var b loginBody
	_ = c.ShouldBindJSON(&b)
	// 入参校验:缺失直接 400(login.ts:21-23)
	if b.Username == "" || b.Password == "" {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "用户名和密码不能为空"})
		return
	}

	user, err := service.FindUserByUsername(c.Request.Context(), b.Username)
	if err != nil {
		slog.Error("login 查询用户失败", "err", err)
		serverError(c)
		return
	}
	if user == nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "用户不存在"})
		return
	}
	if !service.ComparePassword(user.Password, b.Password) {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "密码错误"})
		return
	}

	// 记住我 7d,否则 1h;cookie maxAge 对齐(login.ts:32-33)
	expiresIn := "1h"
	maxAge := SessionMaxAge
	if b.Remember {
		expiresIn = authCfg.JWTExpiresIn
		maxAge = RememberMaxAge
	}
	token, err := service.SignSessionToken(authCfg.JWTSecret, user.ID, user.Username, expiresIn)
	if err != nil {
		serverError(c)
		return
	}
	csrf := GenerateCsrfToken()
	SetAuthCookies(c, token, csrf, maxAge, authCfg.IsProduction)

	// 剔除密码后的全字段 userInfo(login.ts:45)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    user.WithoutPassword(token),
	})
}

// ==================== 刷新(login.ts:54-116) ====================

func handleRefresh(c *gin.Context) {
	token, viaBearer := extractToken(c)
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "message": "缺少刷新令牌"})
		return
	}
	if !viaBearer {
		// CSRF 豁免(26-9-21 修复):csrfToken cookie 与 token 同 maxAge 写入,两者必然同时过期——
		// token 过期时 csrf 也已过期,若在此强制校验,refresh 永不可能成功,用户只能重登。
		// 豁免安全论证:refresh 是幂等续签(不改变业务状态),新 token 走 HttpOnly cookie
		// (JS 读不到),CSRF 攻击者触发 refresh 唯一效果是"受害者 token 被续期",无害。
		cookieToken, err := c.Cookie(CsrfCookie)
		headerToken := c.GetHeader("X-CSRF-Token")
		if err != nil || cookieToken == "" || headerToken == "" || headerToken != cookieToken {
			slog.Warn("refresh CSRF 校验不匹配(已豁免放行)", "err", err, "path", c.Request.URL.Path)
		}
	}

	// 验证 token(过期也要解析出用户信息,login.ts:76-85)
	claims, err := service.VerifySessionToken(authCfg.JWTSecret, token)
	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			if claims, err = service.DecodeSessionTokenWithoutVerify(token); err != nil {
				c.JSON(http.StatusUnauthorized, gin.H{"success": false, "message": "Token无效"})
				return
			}
		} else {
			c.JSON(http.StatusUnauthorized, gin.H{"success": false, "message": "Token无效"})
			return
		}
	}
	// id 为 0 也合法(官方/测试号),这里只判 claims 存在性(login.ts:87-91)
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "message": "Token格式错误"})
		return
	}

	user, err := service.FindActiveUser(c.Request.Context(), claims.ID)
	if err != nil {
		serverError(c)
		return
	}
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"success": false, "message": "用户不存在或已被禁用"})
		return
	}

	newToken, err := service.SignSessionToken(authCfg.JWTSecret, user.ID, user.Username, "1h")
	if err != nil {
		serverError(c)
		return
	}
	SetAuthCookies(c, newToken, GenerateCsrfToken(), SessionMaxAge, authCfg.IsProduction)
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data":    gin.H{"user": user, "token": newToken},
		"message": "Token刷新成功",
	})
}

// ==================== 登出(login.ts:119-122) ====================

func handleLogout(c *gin.Context) {
	ClearAuthCookies(c)
	c.JSON(http.StatusOK, gin.H{"success": true, "message": "已登出"})
}

// ==================== TURN 凭证(turn.ts + turnCredentials.ts) ====================

func handleTurnCredentials(c *gin.Context) {
	user := CurrentUser(c)
	t := authCfg.Turn
	iceServers, ttl := buildTurnIceServers(t.Secret, t.Host, t.STUNPort, t.TLSPort, t.TTLSec, user.ID)
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"iceServers": iceServers, "ttl": ttl})
}

// buildTurnIceServers coturn TURN REST API:username=<expiry>:<userId>,credential=base64(HMAC-SHA1)。
func buildTurnIceServers(secret, host string, stunPort, tlsPort, ttlSec int, userId int64) ([]gin.H, int) {
	if secret == "" || host == "" {
		return []gin.H{}, 0
	}
	expiry := nowUnix() + int64(ttlSec)
	username := strconv.FormatInt(expiry, 10) + ":" + strconv.FormatInt(userId, 10)
	credential := hmacSHA1Base64(secret, username)
	return []gin.H{
		{"urls": []string{"stun:" + host + ":" + strconv.Itoa(stunPort)}},
		{
			"urls": []string{
				"turn:" + host + ":" + strconv.Itoa(stunPort) + "?transport=udp",
				"turn:" + host + ":" + strconv.Itoa(stunPort) + "?transport=tcp",
				"turns:" + host + ":" + strconv.Itoa(tlsPort) + "?transport=tcp",
			},
			"username":   username,
			"credential": credential,
		},
	}, ttlSec
}

// serverError 统一 500 信封。
func serverError(c *gin.Context) {
	c.JSON(http.StatusInternalServerError, gin.H{"success": false, "message": "服务器内部错误"})
}

// isUniqueViolation 判断 pg 唯一约束冲突(SQLSTATE 23505)。
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// nowUnix 当前 unix 秒。
func nowUnix() int64 { return time.Now().Unix() }

// hmacSHA1Base64 HMAC-SHA1 → base64(coturn TURN REST API)。
func hmacSHA1Base64(secret, msg string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(msg))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
