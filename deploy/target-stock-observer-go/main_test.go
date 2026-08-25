package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
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

func TestBuildBulkCycleLogDescribesBatchOnlyRetries(t *testing.T) {
	got := buildBulkCycleLog(44, 20, 24, 24)
	want := "Target bulk cycle: 44 products, 2 batches (batch_size=24), 20 succeeded, 24 deferred; retries use proxy failover only."
	if got != want {
		t.Fatalf("bulk cycle log = %q, want %q", got, want)
	}
}

func TestCycleStatePersistsOnceWhenCycleHasObservations(t *testing.T) {
	if !cycleHasSuccessfulChecks([]checkResult{{current: observation{TCIN: "100"}}}) {
		t.Fatal("successful cycle result should trigger one state save")
	}
	if cycleHasSuccessfulChecks([]checkResult{{err: errors.New("deferred")}}) {
		t.Fatal("failed-only cycle should not trigger a state save")
	}
}

func TestMergeBulkObservationsRecoversProductsFromIncompleteRetry(t *testing.T) {
	products := map[string]string{
		"100": "https://www.target.com/p/-/A-100",
		"200": "https://www.target.com/p/-/A-200",
		"300": "https://www.target.com/p/-/A-300",
	}
	first := []observation{{TCIN: "100", ProductURL: products["100"]}}
	retry := []observation{{TCIN: "200", ProductURL: products["200"]}}
	merged, missing := mergeBulkObservations(first, retry, products)
	if len(merged) != 2 || len(missing) != 1 || missing[0] != products["300"] {
		t.Fatalf("merged=%+v missing=%v", merged, missing)
	}
}

func TestProxyExplorationAdaptsToCycleHealth(t *testing.T) {
	pool := newProxyPool([]string{"http://one:80", "http://two:80", "http://three:80"}, 0, 60*time.Second)
	for range 10 {
		pool.recordCycle(true)
	}
	if got := pool.explorationEvery(); got != stableProxyExplorationEvery {
		t.Fatalf("healthy exploration interval = %d, want %d", got, stableProxyExplorationEvery)
	}
	for range 3 {
		pool.recordCycle(false)
	}
	if got := pool.explorationEvery(); got != recoveryProxyExplorationEvery {
		t.Fatalf("degraded exploration interval = %d, want %d", got, recoveryProxyExplorationEvery)
	}
}

func TestBulkModeSuppressesPerProductFailureLogs(t *testing.T) {
	if shouldLogIndividualCheckFailure(true) {
		t.Fatal("bulk mode should report failures at the batch/cycle level")
	}
	if !shouldLogIndividualCheckFailure(false) {
		t.Fatal("per-product mode should keep individual failure logging")
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

func TestNormalizeTargetProductURLAcceptsBareTCIN(t *testing.T) {
	if got, err := normalizeTargetProductURL("94681790"); err != nil || got != "https://www.target.com/p/-/A-94681790" {
		t.Fatalf("bare TCIN normalized to %q, err=%v", got, err)
	}
	if got, err := normalizeTargetProductURL("https://www.target.com/p/example/-/A-94681790"); err != nil || got != "https://www.target.com/p/example/-/A-94681790" {
		t.Fatalf("Target URL changed to %q, err=%v", got, err)
	}
}

func TestBuildDiscordPayloadIncludesProductDetailsAndTransition(t *testing.T) {
	previous := &observation{TCIN: "123", AvailabilityStatus: "OUT_OF_STOCK", AvailableToPromise: 0, Available: false}
	current := &observation{TCIN: "123", ProductURL: "https://www.target.com/p/-/A-123", AvailabilityStatus: "IN_STOCK", AvailableToPromise: 2, Available: true, ObservedAt: "2026-08-24T20:00:00Z"}
	product := watchlistProduct{Name: "Test Elite Trainer Box", ProductKey: "123", Retailer: "target", ProductURL: current.ProductURL}
	payload := buildDiscordPayload(previous, current, product)
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	for _, want := range []string{"Test Elite Trainer Box", "123", "OUT_OF_STOCK", "IN_STOCK", "0", "2", current.ProductURL, "Target restock detected"} {
		if !strings.Contains(text, want) {
			t.Fatalf("Discord payload %q does not contain %q", text, want)
		}
	}
}

func TestLoadProductURLsReturnsWatchlistMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[{"retailer":"target","name":"Poster Collection","product_key":"123","product_url":"https://www.target.com/p/-/A-123"},{"retailer":"walmart","name":"Other","product_key":"456","product_url":"https://www.walmart.com/ip/456"}]}`)
	}))
	defer server.Close()
	cfg := config{watchlistURL: server.URL}
	urls, metadata, err := loadProductURLs(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(urls) != 1 || urls[0] != "https://www.target.com/p/-/A-123" {
		t.Fatalf("urls = %#v", urls)
	}
	if metadata["123"].Name != "Poster Collection" {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func TestBulkBatchFailureNeverUsesPerProductFallback(t *testing.T) {
	if bulkBatchFallbackAllowed(&targetBlockedError{status: http.StatusForbidden}) {
		t.Fatal("403 batch block should defer without per-product fallback")
	}
	if bulkBatchFallbackAllowed(errors.New("Bad Gateway")) {
		t.Fatal("transport batch failure should defer after bulk proxy retries")
	}
}

func TestBulkMissingProductsUseSingleItemFallback(t *testing.T) {
	if bulkMissingFallbackAllowed(0) {
		t.Fatal("empty missing set should not trigger fallback")
	}
	if !bulkMissingFallbackAllowed(3) {
		t.Fatal("products omitted from an otherwise valid bulk response should be checked individually")
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

func TestProxyPoolReusesClientPerStickyProxy(t *testing.T) {
	pool := newProxyPool([]string{"http://user:secret@proxy.example:80"}, 0, 60*time.Second)
	defer pool.closeIdleConnections()

	first := pool.client(0)
	second := pool.client(0)
	if first == nil || first != second {
		t.Fatal("sticky proxy must reuse one HTTP client and cookie jar")
	}
}

func TestProxyPoolSelectionPrefersProvenWithControlledExploration(t *testing.T) {
	now := time.Unix(100, 0)
	pool := newProxyPool([]string{"http://one:80", "http://two:80", "http://three:80"}, 0, 60*time.Second)
	pool.health[0] = proxyHealth{successes: 5, lastUsedAt: time.Unix(90, 0)}
	pool.health[1] = proxyHealth{successes: 2, lastUsedAt: time.Unix(80, 0)}

	if got := pool.selectReady(now, -1, false); got != 1 {
		t.Fatalf("normal selection = %d, want least-recently-used proven proxy 1", got)
	}
	if got := pool.selectReady(now, -1, true); got != 2 {
		t.Fatalf("exploration selection = %d, want unproven proxy 2", got)
	}
}

func TestProxyHealthRoundTripDoesNotPersistCredentials(t *testing.T) {
	proxy := "http://user:secret@proxy.example:80"
	now := time.Unix(100, 0)
	path := t.TempDir() + "/proxy-health.json"

	pool := newProxyPool([]string{proxy}, 0, 60*time.Second)
	pool.recordSuccess(0, now)
	pool.recordFailure(0, "blocked_403", now.Add(time.Second))
	if err := pool.saveHealth(path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "user") || strings.Contains(string(data), "secret") || strings.Contains(string(data), "proxy.example") {
		t.Fatalf("health state exposed proxy credentials or endpoint: %s", data)
	}

	restored := newProxyPool([]string{proxy}, 0, 60*time.Second)
	if err := restored.loadHealth(path); err != nil {
		t.Fatal(err)
	}
	got := restored.health[0]
	if got.successes != 1 || got.blocked403 != 1 || got.consecutiveFailures != 1 || !got.cooldownUntil.Equal(now.Add(61*time.Second)) {
		t.Fatalf("restored health = %+v", got)
	}
}

func TestProxyPoolSummaryAndLogIncludeCompleteCycleRate(t *testing.T) {
	now := time.Unix(100, 0)
	pool := newProxyPool([]string{"http://one:80", "http://two:80", "http://three:80", "http://four:80"}, 0, 60*time.Second)
	pool.health[0] = proxyHealth{successes: 3}
	pool.health[1] = proxyHealth{}
	pool.health[2] = proxyHealth{successes: 1, consecutiveFailures: 1, cooldownUntil: now.Add(time.Minute), blocked403: 2}
	pool.health[3] = proxyHealth{transportFailures: 1, consecutiveFailures: 1}

	summary := pool.summary(now)
	if summary.total != 4 || summary.proven != 1 || summary.unproven != 1 || summary.cooling != 1 || summary.degraded != 1 || summary.blocked403 != 2 || summary.transportFailures != 1 {
		t.Fatalf("proxy summary = %+v", summary)
	}
	want := "Target proxy pool: 4 total, 1 proven, 1 unproven, 1 cooling, 1 degraded; 403=2, transport=1; full_cycles=12/23 (52.2%), explore_every=10 selections."
	if got := buildProxyPoolLog(summary, 12, 23); got != want {
		t.Fatalf("proxy log = %q, want %q", got, want)
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

func TestProxyPoolClaimNextDoesNotReuseCoolingProxy(t *testing.T) {
	pool := newProxyPool([]string{"http://one:80", "http://two:80"}, 0, 60*time.Second)
	now := time.Unix(100, 0)
	pool.recordFailure(0, "blocked_403", now)
	pool.recordFailure(1, "blocked_403", now)
	if got := pool.claimNext(now, -1); got != -1 {
		t.Fatalf("all-cooling claim = %d, want -1", got)
	}
}

func TestProxyPoolEmergencyClaimUsesEarliestCoolingProxy(t *testing.T) {
	pool := newProxyPool([]string{"http://one:80", "http://two:80", "http://three:80"}, 0, 60*time.Second)
	now := time.Unix(100, 0)
	pool.health[0] = proxyHealth{cooldownUntil: now.Add(3 * time.Minute)}
	pool.health[1] = proxyHealth{cooldownUntil: now.Add(time.Minute)}
	pool.health[2] = proxyHealth{cooldownUntil: now.Add(2 * time.Minute)}

	if got := pool.claimEmergency(now, -1); got != 1 {
		t.Fatalf("emergency claim = %d, want earliest-cooling proxy 1", got)
	}
	if got := pool.claimEmergency(now, 1); got != 2 {
		t.Fatalf("second emergency claim = %d, want next-earliest proxy 2", got)
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
