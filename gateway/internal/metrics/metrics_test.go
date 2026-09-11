package metrics

import (
	"testing"

	dto "github.com/prometheus/client_model/go"
)

// TestDownlinkDurationObservable 冒烟测试:确认 gateway_downlink_duration_seconds 已注册
// 且 Observe 生效(SampleCount 增长),防止后续改动误删/改名导致该指标悄悄消失。
func TestDownlinkDurationObservable(t *testing.T) {
	var before dto.Metric
	if err := DownlinkDuration.Write(&before); err != nil {
		t.Fatalf("write before observe: %v", err)
	}

	DownlinkDuration.Observe(0.01)

	var after dto.Metric
	if err := DownlinkDuration.Write(&after); err != nil {
		t.Fatalf("write after observe: %v", err)
	}

	if after.GetHistogram().GetSampleCount() <= before.GetHistogram().GetSampleCount() {
		t.Fatalf("expected sample count to increase after Observe, before=%d after=%d",
			before.GetHistogram().GetSampleCount(), after.GetHistogram().GetSampleCount())
	}
}
