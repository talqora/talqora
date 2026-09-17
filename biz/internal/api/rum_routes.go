package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/our-chat/biz/internal/metrics"
)

// mountRumRoutes 挂载 RUM web-vitals 信标接收端(routes/rum.ts 同语义)。
func mountRumRoutes(r *gin.Engine) {
	r.POST("/api/rum", handleRum)
}

var rumNames = map[string]bool{"LCP": true, "INP": true, "CLS": true, "FCP": true, "TTFB": true}
var rumRatings = map[string]bool{"good": true, "needs-improvement": true, "poor": true}

// rumBeaconInput zod schema 等价(rum.ts:8-17)。
type rumBeacon struct {
	Name           string   `json:"name"`
	Value          float64  `json:"value"`
	Rating         string   `json:"rating"`
	Delta          *float64 `json:"delta"`
	ID             *string  `json:"id"`
	NavigationType *string  `json:"navigationType"`
	Path           *string  `json:"path"`
	Ts             *float64 `json:"ts"`
}

// handleRum web-vitals 上报(rum.ts:21-31):延迟类 ms→s,CLS 原样;204。
func handleRum(c *gin.Context) {
	var b rumBeacon
	if err := c.ShouldBindJSON(&b); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "RUM 上报参数非法"})
		return
	}
	if !rumNames[b.Name] || !rumRatings[b.Rating] || b.Value < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "RUM 上报参数非法"})
		return
	}
	if b.ID != nil && len(*b.ID) > 128 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "RUM 上报参数非法"})
		return
	}
	if b.NavigationType != nil && len(*b.NavigationType) > 64 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "RUM 上报参数非法"})
		return
	}
	if b.Path != nil && len(*b.Path) > 512 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "message": "RUM 上报参数非法"})
		return
	}

	observed := b.Value
	if b.Name != "CLS" {
		observed = b.Value / 1000
	}
	metrics.RumWebVitals.WithLabelValues(b.Name, b.Rating).Observe(observed)
	c.Status(http.StatusNoContent)
}

var _ = strconv.Itoa
