// Command target-stock-observer polls Target's Redsky fulfillment endpoint.
// It is intentionally browser-free: browser sessions remain the responsibility
// of the existing checkout worker.
package main

import (
	"bytes"
	"crypto/sha256"
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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const redskyURL = "https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_and_variation_hierarchy_v1"
const defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
const monitorService = "target-stock-observer-go"

var tcinPattern = regexp.MustCompile(`(?:^|/)A-(\d+)(?:[/?#]|$)`)
var bareTCINPattern = regexp.MustCompile(`^\d+$`)

type config struct {
	ingestURL, ingestToken, watchlistURL, apiKey, userAgent string
	workerName                                              string
	ingestClient                                            *http.Client
	storeID, zipCode, stateCode, latitude, longitude        string
	proxyFile, stateFile, proxyHealthFile                   string
	checkSeconds, slowCheckSeconds                          int
	concurrency                                             int
	bulkEnabled                                             bool
	bulkBatchSize                                           int
	fastStart, fastEnd                                      int
	productRefresh, errorBackoff                            time.Duration
	blockedBackoff                                          time.Duration
	maxFailovers                                            int
	proxyIndex                                              int
	proxyCooldown                                           time.Duration
	proxyHealthInterval                                     time.Duration
	timeZone                                                *time.Location
	shadow, proxyHealthPublish                              bool
}

type observation struct {
	TCIN               string `json:"tcin"`
	ProductURL         string `json:"product_url"`
	AvailabilityStatus any    `json:"availability_status"`
	AvailableToPromise any    `json:"available_to_promise_quantity"`
	ReasonCode         any    `json:"reason_code"`
	Available          bool   `json:"available"`
	ResponseBytes      int    `json:"response_bytes"`
	ObservedAt         string `json:"observed_at"`
}

type watchlistProduct struct {
	Name       string
	ProductKey string
	ProductURL string
	Retailer   string
}

type shippingOptions struct {
	AvailabilityStatus any `json:"availability_status"`
	AvailableToPromise any `json:"available_to_promise_quantity"`
	ReasonCode         any `json:"reason_code"`
}

type envelope struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

type monitorLog struct {
	WorkerName string `json:"worker_name"`
	Service    string `json:"service"`
	Level      string `json:"level"`
	Message    string `json:"message"`
	CreatedAt  string `json:"created_at"`
}

func buildMonitorLog(workerName, level, message string, now time.Time) monitorLog {
	message = strings.TrimSpace(message)
	if len(message) > 2000 {
		message = message[:2000]
	}
	if message == "" {
		message = "monitor event"
	}
	return monitorLog{
		WorkerName: strings.TrimSpace(workerName),
		Service:    monitorService,
		Level:      strings.TrimSpace(level),
		Message:    message,
		CreatedAt:  now.UTC().Format(time.RFC3339Nano),
	}
}

func buildCycleSummary(total, succeeded, failed int, downloadedBytes int64, available int) string {
	return fmt.Sprintf(
		"Target cycle complete: %d/%d checks succeeded, %d failed, %d available, %.1f KB downloaded.",
		succeeded, total, failed, available, float64(downloadedBytes)/1000,
	)
}

func buildBulkCycleLog(total, succeeded, deferred, batchSize int) string {
	if batchSize < 1 {
		batchSize = defaultBulkBatchSize
	}
	batches := 0
	if total > 0 {
		batches = (total + batchSize - 1) / batchSize
	}
	return fmt.Sprintf(
		"Target bulk cycle: %d products, %d batches (batch_size=%d), %d succeeded, %d deferred; retries use proxy failover only.",
		total, batches, batchSize, succeeded, deferred,
	)
}

func shouldLogIndividualCheckFailure(bulkEnabled bool) bool {
	return !bulkEnabled
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
	responseOK       responseKind = "ok"
	responseBlocked  responseKind = "blocked"
	responseFetch    responseKind = "fetch"
	responseOther    responseKind = "other"
	maxResponseBytes              = 1 << 20
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
	blocked403          int
	blocked429          int
	blocked             int
	transportFailures   int
	consecutiveFailures int
	cooldownUntil       time.Time
	lastFailureAt       time.Time
	lastUsedAt          time.Time
	activeRequests      int
}

type proxyHealthRow struct {
	Proxy              string  `json:"proxy"`
	Successes          int     `json:"successes"`
	Blocked403         int     `json:"blocked_403"`
	Blocked429         int     `json:"blocked_429"`
	NavigationFailures int     `json:"navigation_failures"`
	FetchFailures      int     `json:"fetch_failures"`
	LastFailureAt      *string `json:"last_failure_at"`
	CooldownUntil      *string `json:"cooldown_until"`
}

type proxyPool struct {
	mu             sync.Mutex
	proxies        []string
	clients        []*http.Client
	health         []proxyHealth
	cooldown       time.Duration
	selectionCount uint64
	recentCycles   []bool
}

type proxyPoolSummary struct {
	total, proven, unproven, cooling, degraded int
	blocked403, transportFailures              int
	explorationEvery                           int
}

type persistedProxyHealth struct {
	Successes           int       `json:"successes"`
	Blocked403          int       `json:"blocked_403"`
	Blocked429          int       `json:"blocked_429"`
	Blocked             int       `json:"blocked"`
	TransportFailures   int       `json:"transport_failures"`
	ConsecutiveFailures int       `json:"consecutive_failures"`
	CooldownUntil       time.Time `json:"cooldown_until,omitempty"`
	LastFailureAt       time.Time `json:"last_failure_at,omitempty"`
	LastUsedAt          time.Time `json:"last_used_at,omitempty"`
}

type proxyHealthSnapshot struct {
	Version int                             `json:"version"`
	Proxies map[string]persistedProxyHealth `json:"proxies"`
}

const defaultConcurrency = 12
const maxConcurrency = 32
const defaultBulkBatchSize = 24
const maxBulkBatchSize = 24
const minimumProvenProxies = 3
const defaultProxyExplorationEvery = 10
const stableProxyExplorationEvery = 60
const recoveryProxyExplorationEvery = 6
const proxyCycleHealthWindow = 20
const proxyStableCycleThreshold = 0.9
const proxyRecoveryCycleThreshold = 0.8

func workerCount(products, proxies, configured int) int {
	if products <= 0 || proxies <= 0 {
		return 0
	}
	if configured <= 0 {
		configured = defaultConcurrency
	}
	if configured > maxConcurrency {
		configured = maxConcurrency
	}
	if configured > products {
		configured = products
	}
	if configured > proxies {
		configured = proxies
	}
	return configured
}

func cycleDelay(elapsed, interval time.Duration) time.Duration {
	if interval <= 0 || elapsed >= interval {
		return 0
	}
	return interval - elapsed
}

func splitBulkBatches(urls []string, batchSize int) [][]string {
	if batchSize < 1 {
		batchSize = defaultBulkBatchSize
	}
	result := make([][]string, 0, (len(urls)+batchSize-1)/batchSize)
	for start := 0; start < len(urls); start += batchSize {
		end := min(start+batchSize, len(urls))
		result = append(result, append([]string(nil), urls[start:end]...))
	}
	return result
}

type checkResult struct {
	productURL string
	current    observation
	err        error
}

func cycleHasSuccessfulChecks(results []checkResult) bool {
	for _, result := range results {
		if result.err == nil {
			return true
		}
	}
	return false
}

func runConcurrentCycle(urls []string, cfg config, proxies []string, pool *proxyPool) []checkResult {
	workers := workerCount(len(urls), len(proxies), cfg.concurrency)
	if workers == 0 {
		return nil
	}

	jobs := make(chan string)
	results := make(chan checkResult, len(urls))
	var waitGroup sync.WaitGroup
	waitGroup.Add(workers)
	for range workers {
		proxyIndex := -1
		var client *http.Client
		go func() {
			defer waitGroup.Done()
			defer func() {
				if client != nil {
					client.CloseIdleConnections()
				}
			}()
			for productURL := range jobs {
				if client != nil {
					client.CloseIdleConnections()
				}
				proxyIndex = pool.claimReady(time.Now(), -1)
				if proxyIndex < 0 {
					proxyIndex = pool.claimNext(time.Now(), -1)
				}
				if proxyIndex < 0 {
					results <- checkResult{productURL: productURL, err: errors.New("no proxy available for Target request")}
					continue
				}
				client = newClient(proxies[proxyIndex])
				current, err := fetchWithFailover(&client, proxies, &proxyIndex, pool, cfg, productURL)
				results <- checkResult{productURL: productURL, current: current, err: err}
			}
		}()
	}

	go func() {
		for _, productURL := range urls {
			jobs <- productURL
		}
		close(jobs)
		waitGroup.Wait()
		close(results)
	}()

	collected := make([]checkResult, 0, len(urls))
	for result := range results {
		collected = append(collected, result)
	}
	return collected
}

func newProxyPool(proxies []string, startIndex int, cooldown time.Duration) *proxyPool {
	if len(proxies) == 0 {
		return &proxyPool{}
	}
	pool := &proxyPool{proxies: append([]string(nil), proxies...), clients: make([]*http.Client, len(proxies)), health: make([]proxyHealth, len(proxies)), cooldown: cooldown}
	for index, proxy := range proxies {
		pool.clients[index] = newClient(proxy)
	}
	_ = startIndex
	return pool
}

func (p *proxyPool) client(index int) *http.Client {
	if index < 0 || index >= len(p.clients) {
		return nil
	}
	return p.clients[index]
}

func (p *proxyPool) closeIdleConnections() {
	for _, client := range p.clients {
		if client != nil {
			client.CloseIdleConnections()
		}
	}
}

func (p *proxyPool) recordSuccess(index int, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if index < 0 || index >= len(p.health) {
		return
	}
	p.health[index].successes++
	p.health[index].consecutiveFailures = 0
	p.health[index].cooldownUntil = time.Time{}
	p.health[index].lastUsedAt = now
}

func (p *proxyPool) recordFailure(index int, kind string, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if index < 0 || index >= len(p.health) {
		return
	}
	health := &p.health[index]
	health.consecutiveFailures++
	health.lastFailureAt = now
	health.lastUsedAt = now
	if kind == "blocked_429" {
		health.blocked429++
		health.blocked++
	} else if kind == "blocked" || kind == "blocked_403" {
		health.blocked403++
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

func (p *proxyPool) healthRows(now time.Time) []proxyHealthRow {
	p.mu.Lock()
	defer p.mu.Unlock()
	rows := make([]proxyHealthRow, 0, len(p.health))
	for index, health := range p.health {
		row := proxyHealthRow{
			Proxy:              publicProxyID(p.proxies[index]),
			Successes:          health.successes,
			Blocked403:         health.blocked403,
			Blocked429:         health.blocked429,
			NavigationFailures: 0,
			FetchFailures:      health.transportFailures,
		}
		if !health.lastFailureAt.IsZero() {
			value := health.lastFailureAt.UTC().Format(time.RFC3339Nano)
			row.LastFailureAt = &value
		}
		if health.cooldownUntil.After(now) {
			value := health.cooldownUntil.UTC().Format(time.RFC3339Nano)
			row.CooldownUntil = &value
		}
		rows = append(rows, row)
	}
	return rows
}

func (p *proxyPool) selectReady(now time.Time, current int, explore bool) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.selectReadyLocked(now, current, explore)
}

func (p *proxyPool) selectReadyLocked(now time.Time, current int, explore bool) int {
	proven, unproven, degraded := -1, -1, -1
	for index, health := range p.health {
		if index == current && len(p.proxies) > 1 {
			continue
		}
		if health.activeRequests > 0 || health.cooldownUntil.After(now) {
			continue
		}
		if health.successes > 0 && health.consecutiveFailures == 0 {
			if proven == -1 || health.lastUsedAt.Before(p.health[proven].lastUsedAt) {
				proven = index
			}
			continue
		}
		if health.successes == 0 && health.blocked == 0 && health.transportFailures == 0 {
			if unproven == -1 || health.lastUsedAt.Before(p.health[unproven].lastUsedAt) {
				unproven = index
			}
			continue
		}
		if degraded == -1 || health.lastUsedAt.Before(p.health[degraded].lastUsedAt) {
			degraded = index
		}
	}
	if explore && unproven >= 0 {
		return unproven
	}
	if proven >= 0 {
		return proven
	}
	if unproven >= 0 {
		return unproven
	}
	return degraded
}

func (p *proxyPool) provenReadyCountLocked(now time.Time, current int) int {
	count := 0
	for index, health := range p.health {
		if index == current && len(p.proxies) > 1 {
			continue
		}
		if health.activeRequests == 0 && !health.cooldownUntil.After(now) && health.successes > 0 && health.consecutiveFailures == 0 {
			count++
		}
	}
	return count
}

func (p *proxyPool) recordCycle(full bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.recentCycles = append(p.recentCycles, full)
	if len(p.recentCycles) > proxyCycleHealthWindow {
		p.recentCycles = p.recentCycles[len(p.recentCycles)-proxyCycleHealthWindow:]
	}
}

func (p *proxyPool) explorationEvery() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.explorationEveryLocked()
}

func (p *proxyPool) explorationEveryLocked() int {
	if len(p.recentCycles) < 10 {
		return defaultProxyExplorationEvery
	}
	fullCycles := 0
	for _, full := range p.recentCycles {
		if full {
			fullCycles++
		}
	}
	rate := float64(fullCycles) / float64(len(p.recentCycles))
	if rate >= proxyStableCycleThreshold {
		return stableProxyExplorationEvery
	}
	if rate < proxyRecoveryCycleThreshold {
		return recoveryProxyExplorationEvery
	}
	return defaultProxyExplorationEvery
}

func (p *proxyPool) claimReady(now time.Time, current int) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.proxies) == 0 {
		return -1
	}
	p.selectionCount++
	explorationEvery := p.explorationEveryLocked()
	explore := p.provenReadyCountLocked(now, current) < minimumProvenProxies || p.selectionCount%uint64(explorationEvery) == 0
	best := p.selectReadyLocked(now, current, explore)
	if best >= 0 {
		p.health[best].activeRequests++
		p.health[best].lastUsedAt = now
	}
	return best
}

func (p *proxyPool) claimNext(now time.Time, current int) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.proxies) == 0 {
		return -1
	}
	best := -1
	bestActive := int(^uint(0) >> 1)
	for index, health := range p.health {
		if index == current && len(p.proxies) > 1 {
			continue
		}
		if health.cooldownUntil.After(now) {
			continue
		}
		if best == -1 || health.activeRequests < bestActive ||
			(health.activeRequests == bestActive && health.lastUsedAt.Before(p.health[best].lastUsedAt)) {
			best = index
			bestActive = health.activeRequests
		}
	}
	if best >= 0 {
		p.health[best].activeRequests++
		p.health[best].lastUsedAt = now
	}
	return best
}

func (p *proxyPool) claimEmergency(now time.Time, current int) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	best := -1
	for index, health := range p.health {
		if index == current && len(p.proxies) > 1 {
			continue
		}
		if health.activeRequests > 0 || !health.cooldownUntil.After(now) {
			continue
		}
		if best == -1 || health.cooldownUntil.Before(p.health[best].cooldownUntil) {
			best = index
		}
	}
	if best >= 0 {
		p.health[best].activeRequests++
		p.health[best].lastUsedAt = now
	}
	return best
}

func (p *proxyPool) summary(now time.Time) proxyPoolSummary {
	p.mu.Lock()
	defer p.mu.Unlock()
	result := proxyPoolSummary{total: len(p.health), explorationEvery: p.explorationEveryLocked()}
	for _, health := range p.health {
		result.blocked403 += health.blocked403
		result.transportFailures += health.transportFailures
		switch {
		case health.cooldownUntil.After(now):
			result.cooling++
		case health.successes > 0 && health.consecutiveFailures == 0:
			result.proven++
		case health.successes == 0 && health.blocked == 0 && health.transportFailures == 0:
			result.unproven++
		default:
			result.degraded++
		}
	}
	return result
}

func buildProxyPoolLog(summary proxyPoolSummary, fullCycles, totalCycles int) string {
	rate := 0.0
	if totalCycles > 0 {
		rate = float64(fullCycles) * 100 / float64(totalCycles)
	}
	return fmt.Sprintf(
		"Target proxy pool: %d total, %d proven, %d unproven, %d cooling, %d degraded; 403=%d, transport=%d; full_cycles=%d/%d (%.1f%%), explore_every=%d selections.",
		summary.total, summary.proven, summary.unproven, summary.cooling, summary.degraded,
		summary.blocked403, summary.transportFailures, fullCycles, totalCycles, rate, summary.explorationEvery,
	)
}

func (p *proxyPool) saveHealth(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	p.mu.Lock()
	snapshot := proxyHealthSnapshot{Version: 1, Proxies: make(map[string]persistedProxyHealth, len(p.health))}
	for index, health := range p.health {
		snapshot.Proxies[publicProxyID(p.proxies[index])] = persistedProxyHealth{
			Successes: health.successes, Blocked403: health.blocked403, Blocked429: health.blocked429,
			Blocked: health.blocked, TransportFailures: health.transportFailures,
			ConsecutiveFailures: health.consecutiveFailures, CooldownUntil: health.cooldownUntil,
			LastFailureAt: health.lastFailureAt, LastUsedAt: health.lastUsedAt,
		}
	}
	p.mu.Unlock()

	data, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".proxy-health-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func (p *proxyPool) loadHealth(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var snapshot proxyHealthSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return err
	}
	if snapshot.Version != 1 {
		return fmt.Errorf("unsupported proxy health state version %d", snapshot.Version)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for index, proxy := range p.proxies {
		stored, ok := snapshot.Proxies[publicProxyID(proxy)]
		if !ok {
			continue
		}
		p.health[index] = proxyHealth{
			successes: stored.Successes, blocked403: stored.Blocked403, blocked429: stored.Blocked429,
			blocked: stored.Blocked, transportFailures: stored.TransportFailures,
			consecutiveFailures: stored.ConsecutiveFailures, cooldownUntil: stored.CooldownUntil,
			lastFailureAt: stored.LastFailureAt, lastUsedAt: stored.LastUsedAt,
		}
	}
	return nil
}

func (p *proxyPool) release(index int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if index < 0 || index >= len(p.health) || p.health[index].activeRequests == 0 {
		return
	}
	p.health[index].activeRequests--
}

func publicProxyID(proxy string) string {
	digest := sha256.Sum256([]byte(proxy))
	return "proxy-" + fmt.Sprintf("%x", digest[:6])
}

func (p *proxyPool) chooseNext(now time.Time, current int) int {
	p.mu.Lock()
	defer p.mu.Unlock()
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

func (p *proxyPool) chooseReady(now time.Time, current int) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.proxies) == 0 {
		return -1
	}
	best := -1
	for index, health := range p.health {
		if index == current && len(p.proxies) > 1 {
			continue
		}
		if health.cooldownUntil.After(now) {
			continue
		}
		if best == -1 || health.lastUsedAt.Before(p.health[best].lastUsedAt) {
			best = index
		}
	}
	return best
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	urls, productMetadata, err := loadProductURLs(cfg)
	if err != nil {
		log.Fatal(err)
	}
	proxies, err := loadProxies(cfg.proxyFile)
	if err != nil {
		log.Fatal(err)
	}
	if len(proxies) == 0 {
		log.Fatal("no proxies loaded; refusing a direct Target connection")
	}

	state := loadState(cfg.stateFile)
	proxyPool := newProxyPool(proxies, cfg.proxyIndex%len(proxies), cfg.proxyCooldown)
	defer proxyPool.closeIdleConnections()
	if err := proxyPool.loadHealth(cfg.proxyHealthFile); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("proxy health restore failed: %v", err)
		}
	} else {
		log.Printf("restored proxy health for %d proxies", len(proxies))
	}
	var downloadedBytes int64
	var lastRefresh, lastBandwidth, lastProxyHealth, lastCycleLog time.Time
	bulkCycles, bulkFullCycles := 0, 0
	lastMode := ""
	startupMessage := fmt.Sprintf("Target Go observer started: %d products, fast=%ds, normal=%ds, concurrency=%d, bulk=%t, bulk_batch=%d, proxy required, shadow=%t.", len(urls), cfg.checkSeconds, cfg.slowCheckSeconds, workerCount(len(urls), len(proxies), cfg.concurrency), cfg.bulkEnabled, cfg.bulkBatchSize, cfg.shadow)
	log.Printf("%s", startupMessage)
	publishMonitorLog(cfg, "info", startupMessage)

	for {
		cycleStarted := time.Now()
		mode, scheduled := schedule(cfg, time.Now())
		if mode != lastMode {
			scheduleMessage := fmt.Sprintf("Target polling schedule: mode=%s, interval=%s.", mode, scheduled)
			log.Printf("%s", scheduleMessage)
			publishMonitorLog(cfg, "info", scheduleMessage)
			lastMode = mode
		}
		if lastRefresh.IsZero() || time.Since(lastRefresh) >= cfg.productRefresh {
			previousProductCount := len(urls)
			if refreshed, refreshedMetadata, refreshErr := loadProductURLs(cfg); refreshErr != nil {
				log.Printf("watchlist refresh failed: %v", refreshErr)
				publishMonitorLog(cfg, "warn", fmt.Sprintf("Target watchlist refresh failed: %v", refreshErr))
			} else if len(refreshed) > 0 {
				urls = refreshed
				productMetadata = refreshedMetadata
				if len(urls) != previousProductCount {
					publishMonitorLog(cfg, "info", fmt.Sprintf("Target watchlist refreshed: %d products.", len(urls)))
				}
			}
			lastRefresh = time.Now()
		}

		cycleBlocked := false
		cycleChecks, cycleFailed, cycleAvailable := 0, 0, 0
		var cycleBytes int64
		availabilityTransition := false
		var results []checkResult
		if cfg.bulkEnabled {
			results = runBulkCycle(urls, cfg, proxies, proxyPool)
		} else {
			results = runConcurrentCycle(urls, cfg, proxies, proxyPool)
		}
		stateSaveNeeded := cycleHasSuccessfulChecks(results)
		for _, result := range results {
			if result.err != nil {
				cycleFailed++
				var blocked *targetBlockedError
				if errors.As(result.err, &blocked) {
					cycleBlocked = true
				}
				if shouldLogIndividualCheckFailure(cfg.bulkEnabled) {
					log.Printf("check failed for %s: %s", result.productURL, safeProxyError(result.err))
					if blocked != nil {
						publishMonitorLog(cfg, "warn", fmt.Sprintf("Target request blocked for %s; proxy failover engaged.", result.productURL))
					}
				}
			} else {
				current := result.current
				cycleChecks++
				if current.Available {
					cycleAvailable++
				}
				downloadedBytes += int64(current.ResponseBytes)
				cycleBytes += int64(current.ResponseBytes)
				previous := state[current.TCIN]
				log.Printf("tcin=%s status=%v atp=%v reason=%v bytes=%d", current.TCIN, current.AvailabilityStatus, current.AvailableToPromise, current.ReasonCode, current.ResponseBytes)
				if previous != nil && previous.Available != current.Available {
					availabilityTransition = true
					publishMonitorLog(cfg, "info", fmt.Sprintf("Target stock transition: TCIN %s is now %s.", current.TCIN, current.AvailabilityStatus))
				}
				if !cfg.shadow {
					if inventoryChanged(previous, &current) {
						if err := postIngest(cfg, "target_inventory", current); err != nil {
							log.Printf("inventory publish failed: %v", err)
							publishMonitorLog(cfg, "error", fmt.Sprintf("Inventory publish failed for TCIN %s: %v", current.TCIN, err))
						}
					}
					if previous != nil && !previous.Available && current.Available {
						if err := postDrop(cfg, current, productMetadata[current.TCIN]); err != nil {
							log.Printf("drop publish failed: %v", err)
							publishMonitorLog(cfg, "error", fmt.Sprintf("Drop publish failed for TCIN %s: %v", current.TCIN, err))
						}
						if err := sendDiscord(cfg, previous, &current, productMetadata[current.TCIN]); err != nil {
							log.Printf("Discord alert failed: %v", err)
							publishMonitorLog(cfg, "error", fmt.Sprintf("Discord alert failed for TCIN %s: %v", current.TCIN, err))
						} else {
							name := productMetadata[current.TCIN].Name
							if strings.TrimSpace(name) == "" {
								name = "Target TCIN " + current.TCIN
							}
							log.Printf("Discord alert sent: tcin=%s name=%q status=%v", current.TCIN, name, current.AvailabilityStatus)
						}
					}
				} else if previous != nil && !previous.Available && current.Available {
					log.Printf("SHADOW availability transition detected for tcin=%s", current.TCIN)
				}
				state[current.TCIN] = &current
			}
		}
		if stateSaveNeeded {
			saveState(cfg.stateFile, state)
		}
		if cycleBlocked {
			if cfg.bulkEnabled {
				log.Printf("Target cycle had blocked requests; proxy failover handled by bulk batch.")
			} else {
				log.Printf("Target cycle had blocked requests; proxy failover handled per worker.")
			}
		}
		if cfg.bulkEnabled {
			bulkCycles++
			fullCycle := cycleFailed == 0 && cycleChecks == len(urls)
			proxyPool.recordCycle(fullCycle)
			if fullCycle {
				bulkFullCycles++
			}
			bulkCycleMessage := buildBulkCycleLog(len(urls), cycleChecks, cycleFailed, cfg.bulkBatchSize)
			bulkCycleLevel := "info"
			if cycleFailed > 0 {
				bulkCycleLevel = "warn"
			}
			log.Printf("%s", bulkCycleMessage)
			publishMonitorLog(cfg, bulkCycleLevel, bulkCycleMessage)
		}
		if cfg.proxyHealthPublish && (lastProxyHealth.IsZero() || time.Since(lastProxyHealth) >= cfg.proxyHealthInterval) {
			proxyPoolMessage := buildProxyPoolLog(proxyPool.summary(time.Now()), bulkFullCycles, bulkCycles)
			log.Printf("%s", proxyPoolMessage)
			publishMonitorLog(cfg, "info", proxyPoolMessage)
			if err := postIngest(cfg, "proxy_health", proxyPool.healthRows(time.Now())); err != nil {
				log.Printf("proxy health publish failed: %v", err)
			} else {
				log.Printf("proxy health published (%d proxies)", len(proxyPool.health))
			}
			lastProxyHealth = time.Now()
		}
		if time.Since(lastBandwidth) >= time.Hour {
			log.Printf("Target response bodies downloaded since startup: %.3f MB", float64(downloadedBytes)/1_000_000)
			lastBandwidth = time.Now()
		}
		if lastCycleLog.IsZero() || time.Since(lastCycleLog) >= 5*time.Minute || cycleFailed > 0 || availabilityTransition {
			publishMonitorLog(cfg, "info", buildCycleSummary(len(urls), cycleChecks, cycleFailed, cycleBytes, cycleAvailable))
			lastCycleLog = time.Now()
		}
		if err := proxyPool.saveHealth(cfg.proxyHealthFile); err != nil {
			log.Printf("proxy health save failed: %v", err)
		}
		if delay := cycleDelay(time.Since(cycleStarted), scheduled); delay > 0 {
			time.Sleep(delay)
		}
	}
}

func loadConfig() (config, error) {
	zoneName := env("TARGET_STOCK_TIME_ZONE", "America/Los_Angeles")
	zone, err := time.LoadLocation(zoneName)
	if err != nil {
		return config{}, fmt.Errorf("load timezone %s: %w", zoneName, err)
	}
	start, err := parseClock(env("TARGET_STOCK_FAST_WINDOW_START", "23:30"))
	if err != nil {
		return config{}, err
	}
	end, err := parseClock(env("TARGET_STOCK_FAST_WINDOW_END", "03:30"))
	if err != nil {
		return config{}, err
	}
	check := envInt("TARGET_STOCK_CHECK_SECONDS", 30)
	if check < 15 {
		check = 15
	}
	slow := envInt("TARGET_STOCK_SLOW_CHECK_SECONDS", 300)
	if slow < check {
		slow = check
	}
	concurrency := envInt("TARGET_STOCK_CONCURRENCY", defaultConcurrency)
	ingest := strings.TrimSpace(os.Getenv("POKEALERT_INGEST_URL"))
	token := strings.TrimSpace(os.Getenv("POKEALERT_INGEST_TOKEN"))
	if ingest == "" || token == "" {
		return config{}, errors.New("POKEALERT_INGEST_URL and POKEALERT_INGEST_TOKEN are required")
	}
	apiKey := strings.TrimSpace(os.Getenv("TARGET_REDSKY_API_KEY"))
	if apiKey == "" {
		return config{}, errors.New("TARGET_REDSKY_API_KEY is required")
	}
	return config{
		ingestURL: ingest, ingestToken: token,
		workerName: env("POKEALERT_WORKER_NAME", "pokebot-worker"), ingestClient: &http.Client{Timeout: 20 * time.Second},
		watchlistURL: env("POKEALERT_WATCHLIST_URL", strings.Replace(ingest, "/api/ingest", "/api/watchlist", 1)),
		apiKey:       apiKey, userAgent: env("TARGET_STOCK_USER_AGENT", defaultUserAgent), storeID: env("TARGET_STOCK_STORE_ID", "3294"), zipCode: env("TARGET_STOCK_ZIP", "90019"), stateCode: env("TARGET_STOCK_STATE", "CA"), latitude: env("TARGET_STOCK_LATITUDE", "34.040"), longitude: env("TARGET_STOCK_LONGITUDE", "-118.340"),
		proxyFile: env("TARGET_STOCK_PROXY_FILE", "/home/hammikb/api-monitor-python/proxies.txt"), stateFile: env("TARGET_STOCK_STATE_FILE", "/home/hammikb/api-monitor-python/.target-stock-observer-go-state.json"), proxyHealthFile: env("TARGET_STOCK_PROXY_HEALTH_STATE_FILE", "/home/hammikb/target-stock-observer-go/proxy-health-state.json"),
		checkSeconds: check, slowCheckSeconds: slow, concurrency: concurrency, bulkEnabled: envBool("TARGET_STOCK_BULK_ENABLED", false), bulkBatchSize: min(max(envInt("TARGET_STOCK_BULK_BATCH_SIZE", defaultBulkBatchSize), 1), maxBulkBatchSize), fastStart: start, fastEnd: end,
		productRefresh: time.Duration(envInt("TARGET_STOCK_PRODUCT_REFRESH_SECONDS", 300)) * time.Second, errorBackoff: time.Duration(max(envInt("TARGET_STOCK_ERROR_BACKOFF_MAX_SECONDS", 900), 60)) * time.Second, blockedBackoff: time.Duration(max(envInt("TARGET_STOCK_BLOCKED_BACKOFF_SECONDS", 900), 5)) * time.Second, maxFailovers: min(max(envInt("TARGET_STOCK_MAX_FAILOVERS", 2), 0), 8), proxyCooldown: time.Duration(max(envInt("TARGET_STOCK_PROXY_COOLDOWN_SECONDS", 300), 60)) * time.Second, proxyHealthInterval: time.Duration(max(envInt("TARGET_STOCK_PROXY_HEALTH_INTERVAL_SECONDS", 60), 10)) * time.Second,
		proxyIndex: max(envInt("TARGET_STOCK_PROXY_INDEX", 0), 0), timeZone: zone, shadow: envBool("TARGET_STOCK_SHADOW", false), proxyHealthPublish: envBool("TARGET_STOCK_PROXY_HEALTH_PUBLISH", false),
	}, nil
}

func loadProductURLs(cfg config) ([]string, map[string]watchlistProduct, error) {
	urls := []string{}
	metadata := map[string]watchlistProduct{}
	for _, value := range strings.Split(os.Getenv("TARGET_STOCK_URLS"), ",") {
		if strings.TrimSpace(value) != "" {
			urls = append(urls, strings.TrimSpace(value))
		}
	}
	if cfg.watchlistURL != "" {
		request, err := http.NewRequest(http.MethodGet, cfg.watchlistURL, nil)
		if err != nil {
			return nil, nil, fmt.Errorf("build watchlist request: %w", err)
		}
		request.Header.Set("Authorization", "Bearer "+cfg.ingestToken)
		response, err := (&http.Client{Timeout: 20 * time.Second}).Do(request)
		if err != nil {
			return nil, nil, err
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, nil, fmt.Errorf("watchlist failed with HTTP %d", response.StatusCode)
		}
		data, truncated, err := readBoundedBody(response.Body, 2<<20)
		if err != nil {
			return nil, nil, fmt.Errorf("read watchlist: %w", err)
		}
		if truncated {
			return nil, nil, fmt.Errorf("watchlist response exceeded %d bytes", 2<<20)
		}
		var body struct {
			Items []struct {
				Name       string `json:"name"`
				ProductKey string `json:"product_key"`
				Retailer   string `json:"retailer"`
				ProductURL string `json:"product_url"`
			} `json:"items"`
		}
		if err := json.Unmarshal(data, &body); err != nil {
			return nil, nil, err
		}
		for _, item := range body.Items {
			if strings.EqualFold(item.Retailer, "target") {
				urls = append(urls, strings.TrimSpace(item.ProductURL))
				if tcin, err := extractTCIN(item.ProductURL); err == nil {
					metadata[tcin] = watchlistProduct{Name: strings.TrimSpace(item.Name), ProductKey: strings.TrimSpace(item.ProductKey), ProductURL: strings.TrimSpace(item.ProductURL), Retailer: strings.TrimSpace(item.Retailer)}
				}
			}
		}
	}
	deduped := map[string]bool{}
	result := []string{}
	for _, rawValue := range urls {
		productURL, err := normalizeTargetProductURL(rawValue)
		if err != nil {
			continue
		}
		tcin, _ := extractTCIN(productURL)
		if !deduped[tcin] {
			deduped[tcin] = true
			result = append(result, productURL)
			if _, ok := metadata[tcin]; !ok {
				metadata[tcin] = watchlistProduct{ProductKey: tcin, ProductURL: productURL, Retailer: "target"}
			}
		}
	}
	if len(result) == 0 {
		return nil, nil, errors.New("no Target products configured")
	}
	return result, metadata, nil
}

func loadProxies(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	result := []string{}
	for _, raw := range strings.Split(string(data), "\n") {
		value := strings.TrimSpace(raw)
		if value == "" || strings.HasPrefix(value, "#") {
			continue
		}
		if !strings.Contains(value, "://") {
			value = "http://" + value
		}
		parsed, err := url.Parse(value)
		if err == nil && parsed.Hostname() != "" && parsed.Port() != "" {
			result = append(result, value)
		}
	}
	return result, nil
}

func newClient(proxy string) *http.Client {
	proxyURL, _ := url.Parse(proxy)
	jar, _ := cookiejar.New(nil)
	return &http.Client{Timeout: 25 * time.Second, Jar: jar, Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL), MaxIdleConns: 32, MaxIdleConnsPerHost: 8, IdleConnTimeout: 90 * time.Second}}
}

var targetKeyInError = regexp.MustCompile(`([?&]key=)[^&\s]+`)

func safeProxyError(err error) string {
	if err == nil {
		return ""
	}
	return targetKeyInError.ReplaceAllString(err.Error(), "$1[redacted]")
}

func fetchWithFailover(client **http.Client, proxies []string, proxyIndex *int, pool *proxyPool, cfg config, productURL string) (observation, error) {
	maxFailovers := min(cfg.maxFailovers, len(proxies)-1)
	currentProxy := *proxyIndex
	for attempt := 0; ; attempt++ {
		current, err := fetchObservation(*client, cfg, productURL)
		if err == nil {
			if pool != nil {
				pool.recordSuccess(currentProxy, time.Now())
				pool.release(currentProxy)
			}
			return current, nil
		}
		var blocked *targetBlockedError
		if errors.As(err, &blocked) {
			if pool != nil {
				kind := "blocked_403"
				if blocked.status == http.StatusTooManyRequests {
					kind = "blocked_429"
				}
				pool.recordFailure(currentProxy, kind, time.Now())
				pool.release(currentProxy)
			}
			if attempt >= maxFailovers {
				return observation{}, err
			}
			next := (currentProxy + 1) % len(proxies)
			if pool != nil {
				next = pool.claimReady(time.Now(), currentProxy)
				if next < 0 {
					next = pool.claimNext(time.Now(), currentProxy)
				}
			}
			if next < 0 || next == currentProxy {
				return observation{}, err
			}
			(*client).CloseIdleConnections()
			currentProxy = next
			*proxyIndex = currentProxy
			*client = newClient(proxies[currentProxy])
			log.Printf("proxy blocked; cooldown and failover to proxy[%d]: %s", currentProxy+1, safeProxyError(err))
			continue
		}
		if pool != nil {
			pool.recordFailure(currentProxy, "transport", time.Now())
			pool.release(currentProxy)
		}
		if !retryableProxyError(err) || attempt >= maxFailovers {
			return observation{}, err
		}
		next := (currentProxy + 1) % len(proxies)
		if pool != nil {
			next = pool.claimReady(time.Now(), currentProxy)
			if next < 0 {
				next = pool.claimNext(time.Now(), currentProxy)
			}
		}
		if next < 0 || next == currentProxy {
			return observation{}, err
		}
		(*client).CloseIdleConnections()
		currentProxy = next
		*proxyIndex = currentProxy
		*client = newClient(proxies[currentProxy])
		log.Printf("proxy failed; immediate failover to proxy[%d]: %s", currentProxy+1, safeProxyError(err))
	}
}

func fetchBulkBatch(client *http.Client, cfg config, productURLs map[string]string) ([]observation, []string, int64, error) {
	tcins := make([]string, 0, len(productURLs))
	for tcin := range productURLs {
		tcins = append(tcins, tcin)
	}
	request, err := http.NewRequest(http.MethodGet, buildBulkFulfillmentURL(cfg, tcins), nil)
	if err != nil {
		return nil, nil, 0, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Referer", "https://www.target.com/")
	request.Header.Set("User-Agent", cfg.userAgent)
	response, err := client.Do(request)
	if err != nil {
		return nil, nil, 0, err
	}
	defer response.Body.Close()
	data, truncated, err := readBoundedBody(response.Body, maxResponseBytes)
	if err != nil {
		return nil, nil, 0, err
	}
	if truncated {
		return nil, nil, int64(len(data)), fmt.Errorf("Target bulk response exceeded %d bytes", maxResponseBytes)
	}
	if response.StatusCode == http.StatusForbidden || response.StatusCode == http.StatusTooManyRequests {
		return nil, nil, int64(len(data)), &targetBlockedError{status: response.StatusCode, bytes: len(data)}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, int64(len(data)), fmt.Errorf("Target bulk returned HTTP %d", response.StatusCode)
	}
	observations, missing, err := parseBulkObservations(data, productURLs)
	if err != nil {
		return nil, nil, int64(len(data)), err
	}
	if len(observations) > 0 {
		observations[0].ResponseBytes = len(data)
	}
	return observations, missing, int64(len(data)), nil
}

func fetchBulkBatchWithFailover(proxies []string, pool *proxyPool, cfg config, productURLs map[string]string) ([]observation, []string, int64, error) {
	observations, missing, responseBytes, _, err := fetchBulkBatchWithFailoverExcluding(proxies, pool, cfg, productURLs, -1)
	return observations, missing, responseBytes, err
}

func fetchBulkBatchWithFailoverExcluding(proxies []string, pool *proxyPool, cfg config, productURLs map[string]string, excludedProxy int) ([]observation, []string, int64, int, error) {
	if len(proxies) == 0 {
		return nil, nil, 0, -1, errors.New("no proxies available for Target bulk request")
	}
	maxFailovers := min(cfg.maxFailovers, len(proxies)-1)
	currentProxy := excludedProxy
	var totalBytes int64
	for attempt := 0; ; attempt++ {
		emergencyProbe := false
		currentProxy = pool.claimReady(time.Now(), currentProxy)
		if currentProxy < 0 && attempt == 0 {
			currentProxy = pool.claimEmergency(time.Now(), currentProxy)
			emergencyProbe = currentProxy >= 0
			if emergencyProbe {
				log.Printf("all proxies cooling; probing proxy[%d] once for this bulk batch", currentProxy+1)
			}
		}
		if currentProxy < 0 {
			return nil, nil, totalBytes, -1, errors.New("no ready proxy available for Target bulk request")
		}
		client := pool.client(currentProxy)
		if client == nil {
			pool.release(currentProxy)
			return nil, nil, totalBytes, -1, fmt.Errorf("proxy[%d] has no HTTP client", currentProxy+1)
		}
		observations, missing, responseBytes, err := fetchBulkBatch(client, cfg, productURLs)
		totalBytes += responseBytes
		if err == nil {
			pool.recordSuccess(currentProxy, time.Now())
			pool.release(currentProxy)
			return observations, missing, totalBytes, currentProxy, nil
		}
		var blocked *targetBlockedError
		if errors.As(err, &blocked) {
			kind := "blocked_403"
			if blocked.status == http.StatusTooManyRequests {
				kind = "blocked_429"
			}
			pool.recordFailure(currentProxy, kind, time.Now())
		} else {
			pool.recordFailure(currentProxy, "transport", time.Now())
		}
		client.CloseIdleConnections()
		pool.release(currentProxy)
		if emergencyProbe || attempt >= maxFailovers {
			return nil, nil, totalBytes, -1, err
		}
		log.Printf("bulk batch proxy[%d] failed; targeted failover: %s", currentProxy+1, safeProxyError(err))
	}
}

// bulkBatchFallbackAllowed is intentionally always false. A failed batch must
// never fan out into per-product requests; the bulk failover path above owns
// retries, and an exhausted batch is deferred to the next cycle.
func bulkBatchFallbackAllowed(error) bool {
	return false
}

func bulkMissingFallbackAllowed(missing int) bool {
	return missing > 0
}

func runBulkCycle(urls []string, cfg config, proxies []string, pool *proxyPool) []checkResult {
	results := make([]checkResult, 0, len(urls))
	for _, batch := range splitBulkBatches(urls, cfg.bulkBatchSize) {
		productURLs := make(map[string]string, len(batch))
		for _, productURL := range batch {
			tcin, err := extractTCIN(productURL)
			if err != nil {
				results = append(results, checkResult{productURL: productURL, err: err})
				continue
			}
			productURLs[tcin] = productURL
		}
		if len(productURLs) == 0 {
			continue
		}
		observations, missing, responseBytes, successfulProxy, err := fetchBulkBatchWithFailoverExcluding(proxies, pool, cfg, productURLs, -1)
		if err != nil {
			log.Printf("bulk batch failed after proxy retries; deferring %d products to the next cycle: %s", len(productURLs), safeProxyError(err))
			for _, productURL := range productURLs {
				results = append(results, checkResult{productURL: productURL, err: err})
			}
			continue
		}
		if len(missing) > 0 && successfulProxy >= 0 {
			log.Printf("bulk batch incomplete; retrying through proxy failover: missing=%d", len(missing))
			retryObservations, _, retryBytes, _, retryErr := fetchBulkBatchWithFailoverExcluding(proxies, pool, cfg, productURLs, successfulProxy)
			responseBytes += retryBytes
			if retryErr != nil {
				log.Printf("bulk batch incomplete retry failed; deferring remaining missing products: %s", safeProxyError(retryErr))
			} else {
				observations, missing = mergeBulkObservations(observations, retryObservations, productURLs)
			}
		}
		assignBulkResponseBytes(observations, responseBytes)
		for _, current := range observations {
			results = append(results, checkResult{productURL: current.ProductURL, current: current})
		}
		if bulkMissingFallbackAllowed(len(missing)) {
			log.Printf("bulk batch incomplete; checking %d omitted products with single-item fallback", len(missing))
			results = append(results, runConcurrentCycle(missing, cfg, proxies, pool)...)
		}
		log.Printf("bulk batch complete: requested=%d returned=%d missing=%d response_bytes=%d", len(productURLs), len(observations), len(missing), responseBytes)
	}
	return results
}

func buildFulfillmentURL(cfg config, tcin string) (string, error) {
	query := url.Values{"key": {cfg.apiKey}, "tcin": {tcin}, "store_id": {cfg.storeID}, "pricing_store_id": {cfg.storeID}, "required_store_id": {cfg.storeID}, "scheduled_delivery_store_id": {cfg.storeID}, "zip": {cfg.zipCode}, "state": {cfg.stateCode}, "latitude": {cfg.latitude}, "longitude": {cfg.longitude}, "has_pricing_store_id": {"true"}, "visitor_id": {"0"}, "channel": {"WEB"}, "page": {"/p/A-" + tcin}}
	return redskyURL + "?" + query.Encode(), nil
}

func buildBulkFulfillmentURL(cfg config, tcins []string) string {
	query := url.Values{
		"key":                         {cfg.apiKey},
		"tcins":                       {strings.Join(tcins, ",")},
		"store_id":                    {cfg.storeID},
		"pricing_store_id":            {cfg.storeID},
		"required_store_id":           {cfg.storeID},
		"scheduled_delivery_store_id": {cfg.storeID},
		"scheduled_delivery_zip_code": {cfg.zipCode},
		"zip":                         {cfg.zipCode},
		"state":                       {cfg.stateCode},
		"latitude":                    {cfg.latitude},
		"longitude":                   {cfg.longitude},
		"visitor_id":                  {"0"},
		"channel":                     {"WEB"},
		"page":                        {"/c/27p31"},
	}
	return strings.Replace(redskyURL, "product_fulfillment_and_variation_hierarchy_v1", "product_summary_with_fulfillment_v1", 1) + "?" + query.Encode()
}

func fetchObservation(client *http.Client, cfg config, productURL string) (observation, error) {
	tcin, err := extractTCIN(productURL)
	if err != nil {
		return observation{}, err
	}
	targetURL, err := buildFulfillmentURL(cfg, tcin)
	if err != nil {
		return observation{}, err
	}
	request, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return observation{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Referer", "https://www.target.com/")
	request.Header.Set("User-Agent", cfg.userAgent)
	response, err := client.Do(request)
	if err != nil {
		return observation{}, err
	}
	defer response.Body.Close()
	data, truncated, err := readBoundedBody(response.Body, maxResponseBytes)
	if err != nil {
		return observation{}, err
	}
	if truncated {
		return observation{}, fmt.Errorf("Target response exceeded %d bytes", maxResponseBytes)
	}
	kind := classifyTargetResponse(response.StatusCode, response.Header.Get("Content-Type"), data)
	if kind == responseBlocked {
		return observation{}, &targetBlockedError{status: response.StatusCode, bytes: len(data)}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return observation{}, fmt.Errorf("Target returned HTTP %d", response.StatusCode)
	}
	if kind != responseOK {
		return observation{}, fmt.Errorf("Target response was not valid Redsky JSON (HTTP %d, bytes=%d)", response.StatusCode, len(data))
	}
	var body any
	if err := json.Unmarshal(data, &body); err != nil {
		return observation{}, err
	}
	options, ok := findShippingOptions(body)
	if !ok {
		return observation{}, errors.New("Target response did not contain shipping_options")
	}
	return observation{TCIN: tcin, ProductURL: productURL, AvailabilityStatus: options.AvailabilityStatus, AvailableToPromise: options.AvailableToPromise, ReasonCode: options.ReasonCode, Available: isAvailable(options), ResponseBytes: len(data), ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

func parseBulkObservations(data []byte, productURLs map[string]string) ([]observation, []string, error) {
	var payload struct {
		Data struct {
			ProductSummaries []json.RawMessage `json:"product_summaries"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, nil, fmt.Errorf("decode Target bulk response: %w", err)
	}
	if payload.Data.ProductSummaries == nil {
		return nil, nil, errors.New("Target bulk response did not contain data.product_summaries")
	}
	found := make(map[string]bool, len(payload.Data.ProductSummaries))
	observations := make([]observation, 0, len(payload.Data.ProductSummaries))
	for index, raw := range payload.Data.ProductSummaries {
		var product map[string]any
		if err := json.Unmarshal(raw, &product); err != nil {
			return nil, nil, fmt.Errorf("decode Target bulk product %d: %w", index, err)
		}
		value, ok := product["tcin"]
		if !ok {
			if item, itemOK := product["item"].(map[string]any); itemOK {
				value, ok = item["tcin"]
			}
		}
		if !ok {
			continue
		}
		tcin := strings.TrimSpace(fmt.Sprint(value))
		productURL, expected := productURLs[tcin]
		if !expected {
			continue
		}
		options, ok := findShippingOptions(product)
		if !ok {
			continue
		}
		found[tcin] = true
		observations = append(observations, observation{TCIN: tcin, ProductURL: productURL, AvailabilityStatus: options.AvailabilityStatus, AvailableToPromise: options.AvailableToPromise, ReasonCode: options.ReasonCode, Available: isAvailable(options), ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	}
	missing := make([]string, 0)
	for tcin, productURL := range productURLs {
		if !found[tcin] {
			missing = append(missing, productURL)
		}
	}
	return observations, missing, nil
}

func mergeBulkObservations(first, retry []observation, productURLs map[string]string) ([]observation, []string) {
	merged := make([]observation, 0, len(productURLs))
	found := make(map[string]bool, len(productURLs))
	for _, observations := range [][]observation{first, retry} {
		for _, current := range observations {
			if found[current.TCIN] {
				continue
			}
			if productURL, ok := productURLs[current.TCIN]; ok {
				current.ProductURL = productURL
				merged = append(merged, current)
				found[current.TCIN] = true
			}
		}
	}
	missing := make([]string, 0, len(productURLs)-len(merged))
	for tcin, productURL := range productURLs {
		if !found[tcin] {
			missing = append(missing, productURL)
		}
	}
	sort.Strings(missing)
	return merged, missing
}

func assignBulkResponseBytes(observations []observation, responseBytes int64) {
	for index := range observations {
		observations[index].ResponseBytes = 0
	}
	if len(observations) > 0 {
		observations[0].ResponseBytes = int(responseBytes)
	}
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
		if raw, ok := current["shipping_options"].(map[string]any); ok {
			return shippingOptions{raw["availability_status"], raw["available_to_promise_quantity"], raw["reason_code"]}, true
		}
		for _, nested := range current {
			if result, ok := findShippingOptions(nested); ok {
				return result, true
			}
		}
	case []any:
		for _, nested := range current {
			if result, ok := findShippingOptions(nested); ok {
				return result, true
			}
		}
	}
	return shippingOptions{}, false
}

func isAvailable(value shippingOptions) bool {
	status := strings.ToUpper(fmt.Sprint(value.AvailabilityStatus))
	if status == "IN_STOCK" || status == "LIMITED_STOCK" || status == "PREORDER" || status == "PRE_ORDER" || status == "PRE_ORDER_SELLABLE" {
		return true
	}
	quantity, err := strconv.ParseFloat(fmt.Sprint(value.AvailableToPromise), 64)
	return err == nil && quantity > 0
}

func postIngest(cfg config, eventType string, payload any) error {
	return postIngestWithClient(cfg, cfg.ingestClient, eventType, payload)
}

func postIngestWithClient(cfg config, client *http.Client, eventType string, payload any) error {
	body, _ := json.Marshal(envelope{Type: eventType, Payload: payload})
	request, err := http.NewRequest(http.MethodPost, cfg.ingestURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+cfg.ingestToken)
	request.Header.Set("Content-Type", "application/json")
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	io.Copy(io.Discard, response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("ingest failed with HTTP %d", response.StatusCode)
	}
	return nil
}

func postLog(cfg config, level, message string) error {
	return postIngestWithClient(cfg, cfg.ingestClient, "log", buildMonitorLog(cfg.workerName, level, message, time.Now()))
}

func publishMonitorLog(cfg config, level, message string) {
	if err := postLog(cfg, level, message); err != nil {
		log.Printf("monitor log publish failed: %v", err)
	}
}

func postDrop(cfg config, current observation, product watchlistProduct) error {
	name := strings.TrimSpace(product.Name)
	if name == "" {
		name = "Target TCIN " + current.TCIN
	}
	return postIngest(cfg, "drop", map[string]any{"retailer": "target", "product_key": current.TCIN, "product_url": current.ProductURL, "name": name, "drop_type": "inventory_quantity"})
}

func buildDiscordPayload(previous, current *observation, product watchlistProduct) map[string]any {
	name := strings.TrimSpace(product.Name)
	if name == "" {
		name = "Target product " + current.TCIN
	}
	productURL := strings.TrimSpace(current.ProductURL)
	if productURL == "" {
		productURL = product.ProductURL
	}
	previousStatus := "unknown"
	previousATP := any(nil)
	if previous != nil {
		previousStatus = fmt.Sprint(previous.AvailabilityStatus)
		previousATP = previous.AvailableToPromise
	}
	currentStatus := fmt.Sprint(current.AvailabilityStatus)
	description := fmt.Sprintf("%s is available at Target. Status changed %s → %s (ATP %v → %v).", name, previousStatus, currentStatus, previousATP, current.AvailableToPromise)
	fields := []any{
		map[string]any{"name": "Product", "value": name, "inline": false},
		map[string]any{"name": "TCIN", "value": current.TCIN, "inline": true},
		map[string]any{"name": "Availability", "value": fmt.Sprintf("%s → %s", previousStatus, currentStatus), "inline": true},
		map[string]any{"name": "ATP", "value": fmt.Sprintf("%v → %v", previousATP, current.AvailableToPromise), "inline": true},
	}
	if reason := strings.TrimSpace(fmt.Sprint(current.ReasonCode)); reason != "" && reason != "<nil>" {
		fields = append(fields, map[string]any{"name": "Reason", "value": reason, "inline": true})
	}
	return map[string]any{
		"content": productURL,
		"embeds": []any{map[string]any{
			"title":       "Target restock detected",
			"description": description,
			"url":         productURL,
			"color":       0x16a34a,
			"timestamp":   current.ObservedAt,
			"fields":      fields,
		}},
	}
}

func sendDiscord(cfg config, previous, current *observation, product watchlistProduct) error {
	webhook := strings.TrimSpace(os.Getenv("DISCORD_WEBHOOK_URL"))
	if webhook == "" {
		return nil
	}
	body, err := json.Marshal(buildDiscordPayload(previous, current, product))
	if err != nil {
		return err
	}
	request, err := http.NewRequest(http.MethodPost, webhook, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	io.Copy(io.Discard, response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("Discord returned HTTP %d", response.StatusCode)
	}
	return nil
}

func inventoryChanged(previous, current *observation) bool {
	return previous == nil || fmt.Sprint(previous.AvailabilityStatus) != fmt.Sprint(current.AvailabilityStatus) || fmt.Sprint(previous.AvailableToPromise) != fmt.Sprint(current.AvailableToPromise) || fmt.Sprint(previous.ReasonCode) != fmt.Sprint(current.ReasonCode) || previous.Available != current.Available
}

var stateMu sync.Mutex

func loadState(path string) map[string]*observation {
	state := map[string]*observation{}
	data, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(data, &state)
	}
	return state
}
func saveState(path string, state map[string]*observation) {
	stateMu.Lock()
	defer stateMu.Unlock()
	data, err := json.Marshal(state)
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(path), 0755)
	temporary := path + ".tmp"
	if os.WriteFile(temporary, data, 0644) == nil {
		_ = os.Rename(temporary, path)
	}
}

func schedule(cfg config, now time.Time) (string, time.Duration) {
	local := now.In(cfg.timeZone)
	minute := local.Hour()*60 + local.Minute()
	fast := (cfg.fastStart < cfg.fastEnd && minute >= cfg.fastStart && minute < cfg.fastEnd) || (cfg.fastStart >= cfg.fastEnd && (minute >= cfg.fastStart || minute < cfg.fastEnd))
	if fast {
		return "fast", time.Duration(cfg.checkSeconds) * time.Second
	}
	return "slow", time.Duration(cfg.slowCheckSeconds) * time.Second
}
func parseClock(value string) (int, error) {
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return 0, fmt.Errorf("invalid clock time %q", value)
	}
	hour, e1 := strconv.Atoi(parts[0])
	minute, e2 := strconv.Atoi(parts[1])
	if e1 != nil || e2 != nil || hour > 23 || minute > 59 {
		return 0, fmt.Errorf("invalid clock time %q", value)
	}
	return hour*60 + minute, nil
}
func extractTCIN(value string) (string, error) {
	match := tcinPattern.FindStringSubmatch(value)
	if len(match) != 2 {
		return "", fmt.Errorf("cannot extract TCIN from %q", value)
	}
	return match[1], nil
}

func normalizeTargetProductURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", errors.New("empty Target product value")
	}
	if bareTCINPattern.MatchString(value) {
		return "https://www.target.com/p/-/A-" + value, nil
	}
	if _, err := extractTCIN(value); err != nil {
		return "", err
	}
	return value, nil
}
func retryableProxyError(err error) bool {
	text := strings.ToLower(err.Error())
	for _, marker := range []string{"proxy", "timeout", "502", "503", "504", "bad gateway", "server gave http response to https client", "malformed http response", "connection reset", "connection refused"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}
func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil {
		return fallback
	}
	return value
}
func envFloat(key string, fallback float64) float64 {
	value, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(key)), 64)
	if err != nil {
		return fallback
	}
	return value
}
func envBool(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "true" || value == "1" || value == "yes" {
		return true
	}
	if value == "false" || value == "0" || value == "no" {
		return false
	}
	return fallback
}
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
