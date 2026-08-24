package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestWorkerCountSupportsAFullCadenceWithoutUnboundedConcurrency(t *testing.T) {
	if got := workerCount(44, 15, 12); got != 12 {
		t.Fatalf("worker count = %d, want 12", got)
	}
	if got := workerCount(44, 4, 12); got != 4 {
		t.Fatalf("worker count capped by proxies = %d, want 4", got)
	}
	if got := workerCount(44, 15, 0); got != 12 {
		t.Fatalf("default worker count = %d, want 12", got)
	}
}

func TestCycleDelayDoesNotAddAnotherIntervalWhenPassRunsLong(t *testing.T) {
	if got := cycleDelay(10*time.Second, 30*time.Second); got != 20*time.Second {
		t.Fatalf("cycle delay = %s, want 20s", got)
	}
	if got := cycleDelay(45*time.Second, 30*time.Second); got != 0 {
		t.Fatalf("overrun cycle delay = %s, want 0", got)
	}
}

func TestBuildMonitorLogAddsSafeServiceIdentity(t *testing.T) {
	now := time.Date(2026, 8, 23, 20, 0, 0, 0, time.UTC)
	row := buildMonitorLog("pokebot-worker", "info", "cycle complete", now)
	if row.Service != "target-stock-observer-go" || row.WorkerName != "pokebot-worker" {
		t.Fatalf("service identity = %+v", row)
	}
	if row.Message != "cycle complete" || row.Level != "info" {
		t.Fatalf("log fields = %+v", row)
	}
	if row.CreatedAt != now.Format(time.RFC3339Nano) {
		t.Fatalf("created_at = %q", row.CreatedAt)
	}
}

func TestPostLogUsesExistingAuthenticatedIngestEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Errorf("method = %s", request.Method)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer ingest-token" {
			t.Errorf("authorization = %q", got)
		}
		var body struct {
			Type    string     `json:"type"`
			Payload monitorLog `json:"payload"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if body.Type != "log" {
			t.Errorf("event type = %q", body.Type)
		}
		if body.Payload.Service != "target-stock-observer-go" || body.Payload.Message != "cycle complete" {
			t.Errorf("payload = %+v", body.Payload)
		}
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	cfg := config{ingestURL: server.URL, ingestToken: "ingest-token", workerName: "pokebot-worker", ingestClient: server.Client()}
	if err := postLog(cfg, "info", "cycle complete"); err != nil {
		t.Fatal(err)
	}
}

func TestBuildCycleSummaryIncludesBoundedCounters(t *testing.T) {
	got := buildCycleSummary(44, 42, 2, 47200, 1)
	want := "Target cycle complete: 42/44 checks succeeded, 2 failed, 1 available, 47.2 KB downloaded."
	if got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
}

func TestSplitBulkBatchesPreservesWatchlistOrder(t *testing.T) {
	urls := []string{"https://www.target.com/p/-/A-1", "https://www.target.com/p/-/A-2", "https://www.target.com/p/-/A-3"}
	got := splitBulkBatches(urls, 2)
	if len(got) != 2 || strings.Join(got[0], ",") != strings.Join(urls[:2], ",") || strings.Join(got[1], ",") != urls[2] {
		t.Fatalf("bulk batches = %#v", got)
	}
}

func TestParseBulkObservationsReturnsMissingTCINs(t *testing.T) {
	body := []byte(`{"data":{"product_summaries":[{"tcin":"100","fulfillment":{"shipping_options":{"availability_status":"IN_STOCK","available_to_promise_quantity":2}}}]}}`)
	products := map[string]string{"100": "https://www.target.com/p/-/A-100", "200": "https://www.target.com/p/-/A-200"}
	observations, missing, err := parseBulkObservations(body, products)
	if err != nil {
		t.Fatal(err)
	}
	if len(observations) != 1 || observations[0].TCIN != "100" || !observations[0].Available || observations[0].ProductURL != products["100"] {
		t.Fatalf("observations = %+v", observations)
	}
	if len(missing) != 1 || missing[0] != products["200"] {
		t.Fatalf("missing = %v", missing)
	}
}

func TestBulkBatchFallbackPolicyDefersTargetBlocks(t *testing.T) {
	if bulkBatchFallbackAllowed(&targetBlockedError{status: http.StatusForbidden}) {
		t.Fatal("403 batch block should defer instead of launching per-product fallback")
	}
	if !bulkBatchFallbackAllowed(errors.New("Bad Gateway")) {
		t.Fatal("transport gateway failure should use targeted per-product fallback")
	}
}

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

func TestProxyPoolClaimsOnlyReadyUnreservedProxies(t *testing.T) {
	pool := newProxyPool([]string{"http://one:80", "http://two:80", "http://three:80"}, 0, 60*time.Second)
	now := time.Unix(100, 0)
	pool.recordFailure(0, "blocked", now)

	first := pool.claimReady(now, -1)
	second := pool.claimReady(now, -1)
	if first == 0 || second == 0 || first == second {
		t.Fatalf("claims reused a cooling or active proxy: first=%d second=%d", first, second)
	}
	if got := pool.claimReady(now, -1); got != -1 {
		t.Fatalf("third claim = %d, want no unreserved ready proxy", got)
	}
	pool.release(first)
	if got := pool.claimReady(now, -1); got != first {
		t.Fatalf("released proxy claim = %d, want %d", got, first)
	}
}

func TestProxyPoolClaimNextPrefersAReadyProxy(t *testing.T) {
	pool := newProxyPool([]string{"http://one:80", "http://two:80", "http://three:80"}, 0, 60*time.Second)
	now := time.Unix(100, 0)
	pool.recordFailure(0, "blocked", now)
	pool.recordFailure(1, "transport", now)
	if got := pool.claimNext(now, -1); got != 2 {
		t.Fatalf("next claim = %d, want ready proxy 2", got)
	}
}

func TestSafeProxyErrorRedactsTargetKey(t *testing.T) {
	err := errors.New("Get https://redsky.target.com/path?key=secret-value&tcin=123: Bad Gateway")
	got := safeProxyError(err)
	if strings.Contains(got, "secret-value") || !strings.Contains(got, "key=[redacted]") {
		t.Fatalf("redacted error = %q", got)
	}
}

func TestRetryableProxyErrorRecognizesGatewayAndMalformedTLSResponses(t *testing.T) {
	for _, errText := range []string{
		"Get https://redsky.target.com/path: Bad Gateway",
		"Get https://redsky.target.com/path: server gave HTTP response to HTTPS client",
	} {
		if !retryableProxyError(errors.New(errText)) {
			t.Fatalf("retryableProxyError(%q) = false, want true", errText)
		}
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
	t.Setenv("TARGET_STOCK_BULK_ENABLED", "true")
	t.Setenv("TARGET_STOCK_BULK_BATCH_SIZE", "99")
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
	if !cfg.bulkEnabled || cfg.bulkBatchSize != maxBulkBatchSize {
		t.Fatalf("bulk settings = enabled=%v batch=%d", cfg.bulkEnabled, cfg.bulkBatchSize)
	}
}

func TestBuildFulfillmentURLIncludesProductionLocationContext(t *testing.T) {
	cfg := config{apiKey: "key", storeID: "3294", zipCode: "90019", stateCode: "CA", latitude: "34.040", longitude: "-118.340"}
	raw, err := buildFulfillmentURL(cfg, "95280894")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	values := parsed.Query()
	for key, want := range map[string]string{
		"store_id": "3294", "pricing_store_id": "3294", "zip": "90019",
		"state": "CA", "latitude": "34.040", "longitude": "-118.340",
		"visitor_id": "0", "tcin": "95280894",
	} {
		if values.Get(key) != want {
			t.Fatalf("%s = %q, want %q", key, values.Get(key), want)
		}
	}
}

func TestBuildBulkFulfillmentURLUsesTCINListAndLocationContext(t *testing.T) {
	cfg := config{apiKey: "key", storeID: "3294", zipCode: "90019", stateCode: "CA", latitude: "34.040", longitude: "-118.340"}
	parsed, err := url.Parse(buildBulkFulfillmentURL(cfg, []string{"100", "200"}))
	if err != nil {
		t.Fatal(err)
	}
	values := parsed.Query()
	if !strings.HasSuffix(parsed.Path, "product_summary_with_fulfillment_v1") || values.Get("tcins") != "100,200" || values.Get("store_id") != "3294" || values.Get("scheduled_delivery_zip_code") != "90019" || values.Get("page") != "/c/27p31" {
		t.Fatalf("bulk URL = %s", parsed.Redacted())
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
