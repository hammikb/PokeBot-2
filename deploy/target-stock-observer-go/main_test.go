package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestClassifyTargetResponse(t *testing.T) {
	valid := []byte(`{"data":{"product":{"fulfillment":{"shipping_options":{}}}}}`)
	if got := classifyTargetResponse(200, "application/json", valid); got != responseOK {
		t.Fatalf("valid response classified as %q", got)
	}
	if got := classifyTargetResponse(200, "text/html", []byte("<html>captcha</html>")); got != responseBlocked {
		t.Fatalf("200 challenge classified as %q", got)
	}
	if got := classifyTargetResponse(403, "text/html", nil); got != responseBlocked {
		t.Fatalf("403 classified as %q", got)
	}
	if got := classifyTargetResponse(200, "application/json", []byte(`{"error":"unavailable"}`)); got != responseOther {
		t.Fatalf("invalid JSON schema classified as %q", got)
	}
	if got := classifyTargetResponse(503, "text/plain", nil); got != responseOther {
		t.Fatalf("503 classified as %q", got)
	}
}

func TestReadBoundedBody(t *testing.T) {
	body, truncated, err := readBoundedBody(bytes.NewReader([]byte("123456")), 4)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated || string(body) != "1234" {
		t.Fatalf("bounded body = %q, truncated=%v", body, truncated)
	}

	body, truncated, err = readBoundedBody(bytes.NewReader([]byte("1234")), 4)
	if err != nil || truncated || string(body) != "1234" {
		t.Fatalf("exact body = %q, truncated=%v, err=%v", body, truncated, err)
	}
	if _, _, err = readBoundedBody(errReader{}, 4); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("reader error = %v", err)
	}
}

func TestProxyPoolCooldownAndSelection(t *testing.T) {
	pool := newProxyPool([]string{"http://one:80", "http://two:80"}, 0, 60*time.Second)
	pool.recordFailure(0, "blocked", time.Unix(100, 0))
	if got := pool.chooseNext(time.Unix(100, 0), 0); got != 1 {
		t.Fatalf("cooldown selection = %d, want 1", got)
	}
	pool.recordSuccess(1, time.Unix(101, 0))
	if pool.health[1].consecutiveFailures != 0 {
		t.Fatal("success did not reset proxy failures")
	}
	if got := pool.chooseNext(time.Unix(161, 0), 1); got != 0 {
		t.Fatalf("expired cooldown selection = %d, want 0", got)
	}
}

func TestProxyPoolReadySelectionSkipsCoolingProxies(t *testing.T) {
	pool := newProxyPool([]string{"http://one:80", "http://two:80", "http://three:80"}, 0, 60*time.Second)
	now := time.Unix(100, 0)
	pool.recordFailure(0, "blocked", now)
	pool.recordFailure(1, "blocked", now)
	if got := pool.chooseReady(now, 0); got != 2 {
		t.Fatalf("ready selection = %d, want 2", got)
	}
	pool.recordFailure(2, "blocked", now)
	if got := pool.chooseReady(now, 0); got != -1 {
		t.Fatalf("all-cooling selection = %d, want -1", got)
	}
}

func TestProxyHealthRowsAreSafeAndComparable(t *testing.T) {
	pool := newProxyPool([]string{"http://user:secret@example.test:8080"}, 0, 60*time.Second)
	now := time.Unix(100, 0)
	pool.recordSuccess(0, now)
	pool.recordFailure(0, "blocked_403", now.Add(time.Second))
	rows := pool.healthRows(now.Add(2 * time.Second))
	if len(rows) != 1 {
		t.Fatalf("health rows = %d, want 1", len(rows))
	}
	row := rows[0]
	if row.Proxy == "http://user:secret@example.test:8080" || len(row.Proxy) != len("proxy-000000000000") {
		t.Fatalf("proxy was not safely anonymized: %q", row.Proxy)
	}
	if row.Successes != 1 || row.Blocked403 != 1 || row.Blocked429 != 0 || row.FetchFailures != 0 {
		t.Fatalf("unexpected health counters: %+v", row)
	}
	if row.LastFailureAt == nil || row.CooldownUntil == nil {
		t.Fatalf("failure/cooldown timestamps missing: %+v", row)
	}
}

func TestLoadConfigBlockedFailoverSettings(t *testing.T) {
	t.Setenv("POKEALERT_INGEST_URL", "https://example.test/api/ingest")
	t.Setenv("POKEALERT_INGEST_TOKEN", "token")
	t.Setenv("TARGET_REDSKY_API_KEY", "key")
	t.Setenv("TARGET_STOCK_MAX_FAILOVERS", "4")
	t.Setenv("TARGET_STOCK_BLOCKED_BACKOFF_SECONDS", "20")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.maxFailovers != 4 {
		t.Fatalf("max failovers = %d, want 4", cfg.maxFailovers)
	}
	if cfg.blockedBackoff != 20*time.Second {
		t.Fatalf("blocked backoff = %s, want 20s", cfg.blockedBackoff)
	}
}

func TestNewClientUsesAutomaticCompressionAndTimeout(t *testing.T) {
	client := newClient("http://proxy.example:8080")
	defer client.CloseIdleConnections()
	if client.Timeout <= 0 {
		t.Fatal("client timeout is not configured")
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type = %T", client.Transport)
	}
	if transport.DisableCompression {
		t.Fatal("automatic compression must remain enabled")
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
