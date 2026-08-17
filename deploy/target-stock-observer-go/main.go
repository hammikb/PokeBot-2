// Command target-stock-observer polls Target's Redsky fulfillment endpoint.
// It is intentionally browser-free: browser sessions remain the responsibility
// of the existing checkout worker.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const redskyURL = "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_and_variation_hierarchy_v1"
const defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"

var tcinPattern = regexp.MustCompile(`(?:^|/)A-(\d+)(?:[/?#]|$)`)

type config struct {
	ingestURL, ingestToken, watchlistURL, apiKey, userAgent string
	storeID, zipCode, stateCode                  string
	proxyFile, stateFile                         string
	checkSeconds, slowCheckSeconds               int
	fastStart, fastEnd                           int
	requestSpacing, productRefresh, errorBackoff time.Duration
	proxyIndex                                    int
	proxyCooldown                                 time.Duration
	timeZone                                      *time.Location
	shadow                                        bool
}

type observation struct {
	TCIN                     string `json:"tcin"`
	ProductURL              string `json:"product_url"`
	AvailabilityStatus      any    `json:"availability_status"`
	AvailableToPromise      any    `json:"available_to_promise_quantity"`
	ReasonCode              any    `json:"reason_code"`
	Available                bool   `json:"available"`
	ResponseBytes            int    `json:"response_bytes"`
	ObservedAt               string `json:"observed_at"`
}

type shippingOptions struct {
	AvailabilityStatus any `json:"availability_status"`
	AvailableToPromise any `json:"available_to_promise_quantity"`
	ReasonCode any `json:"reason_code"`
}

type envelope struct {
	Type string `json:"type"`
	Payload any `json:"payload"`
}

type targetBlockedError struct {
	status int
	bytes  int
}

func (e *targetBlockedError) Error() string {
	return fmt.Sprintf("Target blocked request with HTTP %d (%d bytes)", e.status, e.bytes)
}

type responseKind string

const (
	responseOK      responseKind = "ok"
	responseBlocked responseKind = "blocked"
	responseFetch   responseKind = "fetch"
	responseOther   responseKind = "other"
	maxResponseBytes             = 1 << 20
)

func classifyTargetResponse(status int, contentType string, body []byte) responseKind {
	trimmed := bytes.TrimSpace(body)
	if status == 403 || status == 429 {
		return responseBlocked
	}
	if status == 200 && bytes.HasPrefix(trimmed, []byte("{")) {
		var envelope struct {
			Data struct {
				Product json.RawMessage `json:"product"`
			} `json:"data"`
		}
		if json.Unmarshal(trimmed, &envelope) == nil && len(envelope.Data.Product) > 0 && string(envelope.Data.Product) != "null" {
			return responseOK
		}
		return responseOther
	}
	lower := strings.ToLower(string(body))
	if status == 200 && (strings.Contains(lower, "captcha") || strings.Contains(lower, "incapsula") || strings.Contains(lower, "automated") || strings.Contains(lower, "access denied") || strings.Contains(strings.ToLower(contentType), "text/html")) {
		return responseBlocked
	}
	if status < 0 {
		return responseFetch
	}
	return responseOther
}

func readBoundedBody(reader io.Reader, limit int) ([]byte, bool, error) {
	if limit < 1 {
		return nil, false, fmt.Errorf("body limit must be positive")
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(limit)+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) > limit {
		return data[:limit], true, nil
	}
	return data, false, nil
}

type proxyHealth struct {
	successes           int
	blocked             int
	transportFailures   int
	consecutiveFailures int
	cooldownUntil       time.Time
	lastUsedAt           time.Time
}

type proxyPool struct {
	proxies        []string
	health         []proxyHealth
	cooldown       time.Duration
}

func newProxyPool(proxies []string, startIndex int, cooldown time.Duration) *proxyPool {
	if len(proxies) == 0 {
		return &proxyPool{}
	}
	pool := &proxyPool{proxies: append([]string(nil), proxies...), health: make([]proxyHealth, len(proxies)), cooldown: cooldown}
	_ = startIndex
	return pool
}

func (p *proxyPool) recordSuccess(index int, now time.Time) {
	if index < 0 || index >= len(p.health) {
		return
	}
	p.health[index].successes++
	p.health[index].consecutiveFailures = 0
	p.health[index].cooldownUntil = time.Time{}
	p.health[index].lastUsedAt = now
}

func (p *proxyPool) recordFailure(index int, kind string, now time.Time) {
	if index < 0 || index >= len(p.health) {
		return
	}
	health := &p.health[index]
	health.consecutiveFailures++
	health.lastUsedAt = now
	if kind == "blocked" {
		health.blocked++
	} else {
		health.transportFailures++
	}
	multiplier := health.consecutiveFailures
	if multiplier > 4 {
		multiplier = 4
	}
	health.cooldownUntil = now.Add(p.cooldown * time.Duration(multiplier))
}

func (p *proxyPool) chooseNext(now time.Time, current int) int {
	if len(p.proxies) == 0 {
		return -1
	}
	best := -1
	bestScore := time.Duration(1<<63 - 1)
	for index, health := range p.health {
		if index == current && len(p.proxies) > 1 {
			continue
		}
		if !health.cooldownUntil.After(now) {
			if best == -1 || health.lastUsedAt.Before(p.health[best].lastUsedAt) {
				best = index
			}
			continue
		}
		remaining := health.cooldownUntil.Sub(now)
		if best == -1 || remaining < bestScore {
			best, bestScore = index, remaining
		}
	}
	if best == -1 {
		return current
	}
	return best
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	cfg, err := loadConfig()
	if err != nil { log.Fatal(err) }
	urls, err := loadProductURLs(cfg)
	if err != nil { log.Fatal(err) }
	proxies, err := loadProxies(cfg.proxyFile)
	if err != nil { log.Fatal(err) }
	if len(proxies) == 0 { log.Fatal("no proxies loaded; refusing a direct Target connection") }

	state := loadState(cfg.stateFile)
	proxyIndex := cfg.proxyIndex % len(proxies)
	proxyPool := newProxyPool(proxies, proxyIndex, cfg.proxyCooldown)
	client := newClient(proxies[proxyIndex])
	defer client.CloseIdleConnections()
	consecutiveErrors := 0
	var downloadedBytes int64
	var lastRefresh, lastBandwidth time.Time
	lastMode := ""
	log.Printf("Target Go observer started (products=%d, fast=%ds, slow=%ds, proxy_required=true, shadow=%t)", len(urls), cfg.checkSeconds, cfg.slowCheckSeconds, cfg.shadow)

	for {
		cycleStarted := time.Now()
		mode, scheduled := schedule(cfg, time.Now())
		if mode != lastMode {
			log.Printf("polling schedule changed: mode=%s interval=%s", mode, scheduled)
			lastMode = mode
		}
		if lastRefresh.IsZero() || time.Since(lastRefresh) >= cfg.productRefresh {
			if refreshed, refreshErr := loadProductURLs(cfg); refreshErr != nil {
				log.Printf("watchlist refresh failed: %v", refreshErr)
			} else if len(refreshed) > 0 {
				urls = refreshed
			}
			lastRefresh = time.Now()
		}

		cycleSucceeded, cycleBlocked := true, false
		for i, productURL := range urls {
			current, fetchErr := fetchWithFailover(&client, proxies, &proxyIndex, proxyPool, cfg, productURL)
			if fetchErr != nil {
				cycleSucceeded = false
				log.Printf("check failed for %s: %v", productURL, fetchErr)
				var blocked *targetBlockedError
				if errors.As(fetchErr, &blocked) { cycleBlocked = true; break }
			} else {
				downloadedBytes += int64(current.ResponseBytes)
				previous := state[current.TCIN]
				log.Printf("tcin=%s status=%v atp=%v reason=%v bytes=%d", current.TCIN, current.AvailabilityStatus, current.AvailableToPromise, current.ReasonCode, current.ResponseBytes)
				if !cfg.shadow {
					if inventoryChanged(previous, &current) {
						if err := postIngest(cfg, "target_inventory", current); err != nil { log.Printf("inventory publish failed: %v", err) }
					}
					if previous != nil && !previous.Available && current.Available {
						if err := postDrop(cfg, current); err != nil { log.Printf("drop publish failed: %v", err) }
						if err := sendDiscord(cfg, previous, &current); err != nil { log.Printf("Discord alert failed: %v", err) }
					}
				} else if previous != nil && !previous.Available && current.Available {
					log.Printf("SHADOW availability transition detected for tcin=%s", current.TCIN)
				}
				state[current.TCIN] = &current
				saveState(cfg.stateFile, state)
			}
			if i+1 < len(urls) && cfg.requestSpacing > 0 { time.Sleep(cfg.requestSpacing) }
		}
		if cycleSucceeded { consecutiveErrors = 0 } else { consecutiveErrors++ }
		if cycleBlocked || consecutiveErrors == 2 || consecutiveErrors == 5 {
			next := proxyPool.chooseNext(time.Now(), proxyIndex)
			if next != proxyIndex {
				client.CloseIdleConnections()
				proxyIndex = next
				client = newClient(proxies[proxyIndex])
			}
			log.Printf("switching proxy after failures: proxy[%d]", proxyIndex+1)
		}
		if time.Since(lastBandwidth) >= time.Hour {
			log.Printf("Target response bodies downloaded since startup: %.3f MB", float64(downloadedBytes)/1_000_000)
			lastBandwidth = time.Now()
		}
		interval := scheduled
		if cycleBlocked { interval = 15 * time.Minute }
		if consecutiveErrors > 0 && !cycleBlocked {
			backoff := scheduled * time.Duration(1<<min(consecutiveErrors, 5))
			if backoff > cfg.errorBackoff { backoff = cfg.errorBackoff }
			if backoff > interval { interval = backoff }
		}
		if elapsed := time.Since(cycleStarted); elapsed < interval { time.Sleep(interval - elapsed) }
	}
}

func loadConfig() (config, error) {
	zoneName := env("TARGET_STOCK_TIME_ZONE", "America/Los_Angeles")
	zone, err := time.LoadLocation(zoneName)
	if err != nil { return config{}, fmt.Errorf("load timezone %s: %w", zoneName, err) }
	start, err := parseClock(env("TARGET_STOCK_FAST_WINDOW_START", "23:30")); if err != nil { return config{}, err }
	end, err := parseClock(env("TARGET_STOCK_FAST_WINDOW_END", "03:30")); if err != nil { return config{}, err }
	check := envInt("TARGET_STOCK_CHECK_SECONDS", 30); if check < 15 { check = 15 }
	slow := envInt("TARGET_STOCK_SLOW_CHECK_SECONDS", 300); if slow < check { slow = check }
	ingest := strings.TrimSpace(os.Getenv("POKEALERT_INGEST_URL"))
	token := strings.TrimSpace(os.Getenv("POKEALERT_INGEST_TOKEN"))
	if ingest == "" || token == "" { return config{}, errors.New("POKEALERT_INGEST_URL and POKEALERT_INGEST_TOKEN are required") }
	apiKey := strings.TrimSpace(os.Getenv("TARGET_REDSKY_API_KEY"))
	if apiKey == "" { return config{}, errors.New("TARGET_REDSKY_API_KEY is required") }
	return config{
		ingestURL: ingest, ingestToken: token,
		watchlistURL: env("POKEALERT_WATCHLIST_URL", strings.Replace(ingest, "/api/ingest", "/api/watchlist", 1)),
		apiKey: apiKey, userAgent: env("TARGET_STOCK_USER_AGENT", defaultUserAgent), storeID: env("TARGET_STOCK_STORE_ID", "1296"), zipCode: env("TARGET_STOCK_ZIP", "90001"), stateCode: env("TARGET_STOCK_STATE", "CA"),
		proxyFile: env("TARGET_STOCK_PROXY_FILE", "/home/hammikb/api-monitor-python/proxies.txt"), stateFile: env("TARGET_STOCK_STATE_FILE", "/home/hammikb/api-monitor-python/.target-stock-observer-go-state.json"),
		checkSeconds: check, slowCheckSeconds: slow, fastStart: start, fastEnd: end,
		requestSpacing: time.Duration(envFloat("TARGET_STOCK_REQUEST_SPACING_SECONDS", 2)*float64(time.Second)), productRefresh: time.Duration(envInt("TARGET_STOCK_PRODUCT_REFRESH_SECONDS", 300))*time.Second, errorBackoff: time.Duration(max(envInt("TARGET_STOCK_ERROR_BACKOFF_MAX_SECONDS", 900), 60))*time.Second, proxyCooldown: time.Duration(max(envInt("TARGET_STOCK_PROXY_COOLDOWN_SECONDS", 300), 60))*time.Second,
		proxyIndex: max(envInt("TARGET_STOCK_PROXY_INDEX", 0), 0), timeZone: zone, shadow: envBool("TARGET_STOCK_SHADOW", false),
	}, nil
}

func loadProductURLs(cfg config) ([]string, error) {
	urls := []string{}
	for _, value := range strings.Split(os.Getenv("TARGET_STOCK_URLS"), ",") { if strings.TrimSpace(value) != "" { urls = append(urls, strings.TrimSpace(value)) } }
	if cfg.watchlistURL != "" {
		request, err := http.NewRequest(http.MethodGet, cfg.watchlistURL, nil)
		if err != nil { return nil, fmt.Errorf("build watchlist request: %w", err) }
		request.Header.Set("Authorization", "Bearer "+cfg.ingestToken)
		response, err := (&http.Client{Timeout: 20*time.Second}).Do(request)
		if err != nil { return nil, err }; defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 { return nil, fmt.Errorf("watchlist failed with HTTP %d", response.StatusCode) }
		data, truncated, err := readBoundedBody(response.Body, 2<<20)
		if err != nil { return nil, fmt.Errorf("read watchlist: %w", err) }
		if truncated { return nil, fmt.Errorf("watchlist response exceeded %d bytes", 2<<20) }
		var body struct{ Items []struct{ Retailer string `json:"retailer"`; ProductURL string `json:"product_url"` } `json:"items"` }
		if err := json.Unmarshal(data, &body); err != nil { return nil, err }
		for _, item := range body.Items { if strings.EqualFold(item.Retailer, "target") { urls = append(urls, strings.TrimSpace(item.ProductURL)) } }
	}
	deduped := map[string]bool{}; result := []string{}
	for _, productURL := range urls { if _, err := extractTCIN(productURL); err == nil { tcin, _ := extractTCIN(productURL); if !deduped[tcin] { deduped[tcin] = true; result = append(result, productURL) } } }
	if len(result) == 0 { return nil, errors.New("no Target products configured") }
	return result, nil
}

func loadProxies(path string) ([]string, error) {
	data, err := os.ReadFile(path); if err != nil { return nil, err }
	result := []string{}
	for _, raw := range strings.Split(string(data), "\n") {
		value := strings.TrimSpace(raw); if value == "" || strings.HasPrefix(value, "#") { continue }
		if !strings.Contains(value, "://") { value = "http://" + value }
		parsed, err := url.Parse(value); if err == nil && parsed.Hostname() != "" && parsed.Port() != "" { result = append(result, value) }
	}
	return result, nil
}

func newClient(proxy string) *http.Client {
	proxyURL, _ := url.Parse(proxy)
	jar, _ := cookiejar.New(nil)
	return &http.Client{Timeout: 25*time.Second, Jar: jar, Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL), MaxIdleConns: 32, MaxIdleConnsPerHost: 8, IdleConnTimeout: 90*time.Second}}
}

func fetchWithFailover(client **http.Client, proxies []string, proxyIndex *int, pool *proxyPool, cfg config, productURL string) (observation, error) {
	maxFailovers := min(2, len(proxies)-1)
	for attempt := 0; ; attempt++ {
		current, err := fetchObservation(*client, cfg, productURL)
		if err == nil {
			if pool != nil { pool.recordSuccess(*proxyIndex, time.Now()) }
			return current, nil
		}
		var blocked *targetBlockedError
		if errors.As(err, &blocked) {
			if pool != nil { pool.recordFailure(*proxyIndex, "blocked", time.Now()) }
			return observation{}, err
		}
		if pool != nil { pool.recordFailure(*proxyIndex, "transport", time.Now()) }
		if !retryableProxyError(err) || attempt >= maxFailovers { return observation{}, err }
		next := (*proxyIndex + 1) % len(proxies)
		if pool != nil { next = pool.chooseNext(time.Now(), *proxyIndex) }
		if next == *proxyIndex { return observation{}, err }
		(*client).CloseIdleConnections()
		*proxyIndex = next
		*client = newClient(proxies[*proxyIndex])
		log.Printf("proxy failed; immediate failover to proxy[%d]: %v", *proxyIndex+1, err)
	}
}

func fetchObservation(client *http.Client, cfg config, productURL string) (observation, error) {
	tcin, err := extractTCIN(productURL); if err != nil { return observation{}, err }
	query := url.Values{"key": {cfg.apiKey}, "tcin": {tcin}, "store_id": {cfg.storeID}, "pricing_store_id": {cfg.storeID}, "zip": {cfg.zipCode}, "state": {cfg.stateCode}, "has_pricing_store_id": {"true"}, "visitor_id": {"0"}, "channel": {"WEB"}, "page": {"/p/A-" + tcin}}
	request, err := http.NewRequest(http.MethodGet, redskyURL+"?"+query.Encode(), nil); if err != nil { return observation{}, err }
	request.Header.Set("Accept", "application/json"); request.Header.Set("Referer", "https://www.target.com/"); request.Header.Set("User-Agent", cfg.userAgent)
	response, err := client.Do(request); if err != nil { return observation{}, err }; defer response.Body.Close()
	data, truncated, err := readBoundedBody(response.Body, maxResponseBytes); if err != nil { return observation{}, err }
	if truncated { return observation{}, fmt.Errorf("Target response exceeded %d bytes", maxResponseBytes) }
	kind := classifyTargetResponse(response.StatusCode, response.Header.Get("Content-Type"), data)
	if kind == responseBlocked { return observation{}, &targetBlockedError{status: response.StatusCode, bytes: len(data)} }
	if response.StatusCode < 200 || response.StatusCode >= 300 { return observation{}, fmt.Errorf("Target returned HTTP %d", response.StatusCode) }
	if kind != responseOK { return observation{}, fmt.Errorf("Target response was not valid Redsky JSON (HTTP %d, bytes=%d)", response.StatusCode, len(data)) }
	var body any; if err := json.Unmarshal(data, &body); err != nil { return observation{}, err }
	options, ok := findShippingOptions(body); if !ok { return observation{}, errors.New("Target response did not contain shipping_options") }
	return observation{TCIN: tcin, ProductURL: productURL, AvailabilityStatus: options.AvailabilityStatus, AvailableToPromise: options.AvailableToPromise, ReasonCode: options.ReasonCode, Available: isAvailable(options), ResponseBytes: len(data), ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

func findShippingOptions(value any) (shippingOptions, bool) {
	if root, ok := value.(map[string]any); ok {
		if data, ok := root["data"].(map[string]any); ok {
			if product, ok := data["product"].(map[string]any); ok {
				if fulfillment, ok := product["fulfillment"].(map[string]any); ok {
					if options, ok := fulfillment["shipping_options"].(map[string]any); ok {
						return shippingOptions{options["availability_status"], options["available_to_promise_quantity"], options["reason_code"]}, true
					}
				}
			}
		}
	}
	switch current := value.(type) {
	case map[string]any:
		if raw, ok := current["shipping_options"].(map[string]any); ok { return shippingOptions{raw["availability_status"], raw["available_to_promise_quantity"], raw["reason_code"]}, true }
		for _, nested := range current { if result, ok := findShippingOptions(nested); ok { return result, true } }
	case []any:
		for _, nested := range current { if result, ok := findShippingOptions(nested); ok { return result, true } }
	}
	return shippingOptions{}, false
}

func isAvailable(value shippingOptions) bool {
	status := strings.ToUpper(fmt.Sprint(value.AvailabilityStatus))
	if status == "IN_STOCK" || status == "LIMITED_STOCK" || status == "PREORDER" || status == "PRE_ORDER" || status == "PRE_ORDER_SELLABLE" { return true }
	quantity, err := strconv.ParseFloat(fmt.Sprint(value.AvailableToPromise), 64)
	return err == nil && quantity > 0
}

func postIngest(cfg config, eventType string, payload any) error {
	body, _ := json.Marshal(envelope{Type: eventType, Payload: payload})
	request, _ := http.NewRequest(http.MethodPost, cfg.ingestURL, bytes.NewReader(body)); request.Header.Set("Authorization", "Bearer "+cfg.ingestToken); request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 20*time.Second}).Do(request); if err != nil { return err }; defer response.Body.Close(); io.Copy(io.Discard, response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 { return fmt.Errorf("ingest failed with HTTP %d", response.StatusCode) }; return nil
}

func postDrop(cfg config, current observation) error { return postIngest(cfg, "drop", map[string]any{"retailer": "target", "product_key": current.TCIN, "product_url": current.ProductURL, "name": "Target TCIN " + current.TCIN, "drop_type": "inventory_quantity"}) }

func sendDiscord(cfg config, previous, current *observation) error {
	webhook := strings.TrimSpace(os.Getenv("DISCORD_WEBHOOK_URL")); if webhook == "" { return nil }
	message := fmt.Sprintf("Target TCIN %s changed to %v (ATP %v -> %v).", current.TCIN, current.AvailabilityStatus, previous.AvailableToPromise, current.AvailableToPromise)
	body, _ := json.Marshal(map[string]any{"content": current.ProductURL, "embeds": []any{map[string]any{"title": "Target stock change detected", "description": message, "url": current.ProductURL, "color": 0xcc0000, "timestamp": current.ObservedAt}}})
	request, _ := http.NewRequest(http.MethodPost, webhook, bytes.NewReader(body)); request.Header.Set("Content-Type", "application/json"); response, err := (&http.Client{Timeout: 15*time.Second}).Do(request); if err != nil { return err }; defer response.Body.Close(); io.Copy(io.Discard, response.Body); if response.StatusCode < 200 || response.StatusCode >= 300 { return fmt.Errorf("Discord returned HTTP %d", response.StatusCode) }; return nil
}

func inventoryChanged(previous, current *observation) bool { return previous == nil || fmt.Sprint(previous.AvailabilityStatus) != fmt.Sprint(current.AvailabilityStatus) || fmt.Sprint(previous.AvailableToPromise) != fmt.Sprint(current.AvailableToPromise) || fmt.Sprint(previous.ReasonCode) != fmt.Sprint(current.ReasonCode) || previous.Available != current.Available }

var stateMu sync.Mutex
func loadState(path string) map[string]*observation { state := map[string]*observation{}; data, err := os.ReadFile(path); if err == nil { _ = json.Unmarshal(data, &state) }; return state }
func saveState(path string, state map[string]*observation) { stateMu.Lock(); defer stateMu.Unlock(); data, err := json.Marshal(state); if err != nil { return }; _ = os.MkdirAll(filepath.Dir(path), 0755); temporary := path + ".tmp"; if os.WriteFile(temporary, data, 0644) == nil { _ = os.Rename(temporary, path) } }

func schedule(cfg config, now time.Time) (string, time.Duration) { local := now.In(cfg.timeZone); minute := local.Hour()*60 + local.Minute(); fast := (cfg.fastStart < cfg.fastEnd && minute >= cfg.fastStart && minute < cfg.fastEnd) || (cfg.fastStart >= cfg.fastEnd && (minute >= cfg.fastStart || minute < cfg.fastEnd)); if fast { return "fast", time.Duration(cfg.checkSeconds)*time.Second }; return "slow", time.Duration(cfg.slowCheckSeconds)*time.Second }
func parseClock(value string) (int, error) { parts := strings.Split(value, ":"); if len(parts) != 2 { return 0, fmt.Errorf("invalid clock time %q", value) }; hour, e1 := strconv.Atoi(parts[0]); minute, e2 := strconv.Atoi(parts[1]); if e1 != nil || e2 != nil || hour > 23 || minute > 59 { return 0, fmt.Errorf("invalid clock time %q", value) }; return hour*60 + minute, nil }
func extractTCIN(value string) (string, error) { match := tcinPattern.FindStringSubmatch(value); if len(match) != 2 { return "", fmt.Errorf("cannot extract TCIN from %q", value) }; return match[1], nil }
func retryableProxyError(err error) bool { text := strings.ToLower(err.Error()); for _, marker := range []string{"proxy", "timeout", "502", "503", "504", "connection reset", "connection refused"} { if strings.Contains(text, marker) { return true } }; return false }
func env(key, fallback string) string { if value := strings.TrimSpace(os.Getenv(key)); value != "" { return value }; return fallback }
func envInt(key string, fallback int) int { value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key))); if err != nil { return fallback }; return value }
func envFloat(key string, fallback float64) float64 { value, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(key)), 64); if err != nil { return fallback }; return value }
func envBool(key string, fallback bool) bool { value := strings.ToLower(strings.TrimSpace(os.Getenv(key))); if value == "true" || value == "1" || value == "yes" { return true }; if value == "false" || value == "0" || value == "no" { return false }; return fallback }
func min(a, b int) int { if a < b { return a }; return b }
func max(a, b int) int { if a > b { return a }; return b }
