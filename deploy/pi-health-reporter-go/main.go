// Command pi-health-reporter publishes lightweight Raspberry Pi telemetry to
// the existing PokeAlert ingest endpoint. It intentionally has no third-party
// dependencies and does not launch browsers or monitor products.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type health struct {
	WorkerName    string   `json:"worker_name"`
	Hostname      string   `json:"hostname"`
	Platform      string   `json:"platform"`
	CPUPercent    *float64 `json:"cpu_percent"`
	Load1M        *float64 `json:"load_1m"`
	DiskPercent   *float64 `json:"disk_percent"`
	TempC         *float64 `json:"temp_c"`
	UptimeSeconds *int     `json:"uptime_seconds"`
	MemTotalMB    *float64 `json:"mem_total_mb"`
	MemUsedMB     *float64 `json:"mem_used_mb"`
	MemPercent    *float64 `json:"mem_percent"`
	UpdatedAt     string   `json:"updated_at"`
}

type envelope struct {
	SchemaVersion int    `json:"schema_version"`
	EventID       string `json:"event_id"`
	Source        string `json:"source"`
	SentAt        string `json:"sent_at"`
	Attempt       int    `json:"attempt"`
	Type          string `json:"type"`
	Payload       health `json:"payload"`
}

type cpuTimes struct{ values [8]uint64 }

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	interval := time.Duration(envInt("PI_HEALTH_INTERVAL", 60)) * time.Second
	if interval < time.Second {
		interval = time.Second
	}

	endpoint := strings.TrimSpace(os.Getenv("POKEALERT_INGEST_URL"))
	token := strings.TrimSpace(os.Getenv("POKEALERT_INGEST_TOKEN"))
	if endpoint == "" || token == "" {
		log.Fatal("POKEALERT_INGEST_URL and POKEALERT_INGEST_TOKEN must be set")
	}

	hostname, _ := os.Hostname()
	workerName := strings.TrimSpace(os.Getenv("POKEALERT_WORKER_NAME"))
	if workerName == "" {
		workerName = hostname
	}
	log.Printf("starting Go Pi health reporter as %s", workerName)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	client := &http.Client{Timeout: 15 * time.Second}
	previousCPU := readCPUTimes()

	// Publish promptly on startup, then on the configured interval.
	publish := func() {
		currentCPU := readCPUTimes()
		cpu := cpuPercent(previousCPU, currentCPU)
		if currentCPU != nil {
			previousCPU = currentCPU
		}
		payload := collectHealth(workerName, hostname, cpu)
		if err := postHealth(ctx, client, endpoint, token, payload); err != nil {
			log.Printf("publish failed: %v", err)
			return
		}
		log.Printf("published health: cpu=%s temp=%s", formatPtr(payload.CPUPercent), formatPtr(payload.TempC))
	}
	publish()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("stopping Go Pi health reporter")
			return
		case <-ticker.C:
			publish()
		}
	}
}

func collectHealth(workerName, hostname string, cpu *float64) health {
	memTotal, memUsed, memPercent := readMemInfo()
	diskPercent := readDiskPercent("/")
	temp := readTemperature()
	uptime := readUptime()
	load := readLoad1M()
	return health{
		WorkerName: workerName, Hostname: hostname, Platform: platformName(),
		CPUPercent: cpu, Load1M: load, DiskPercent: diskPercent, TempC: temp,
		UptimeSeconds: uptime, MemTotalMB: memTotal, MemUsedMB: memUsed,
		MemPercent: memPercent, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func postHealth(ctx context.Context, client *http.Client, endpoint, token string, payload health) error {
	eventID, err := newEventID()
	if err != nil {
		return err
	}
	var lastErr error
	for attempt := 1; attempt <= 2; attempt++ {
		body, marshalErr := json.Marshal(envelope{
			SchemaVersion: 1,
			EventID:       eventID,
			Source:        payload.WorkerName,
			SentAt:        time.Now().UTC().Format(time.RFC3339Nano),
			Attempt:       attempt,
			Type:          "worker_health",
			Payload:       payload,
		})
		if marshalErr != nil {
			return marshalErr
		}
		req, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if requestErr != nil {
			return requestErr
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		resp, requestErr := client.Do(req)
		if requestErr != nil {
			lastErr = requestErr
		} else {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				return nil
			}
			lastErr = fmt.Errorf("ingest failed with HTTP %d", resp.StatusCode)
			if resp.StatusCode < 500 || resp.StatusCode >= 600 {
				return lastErr
			}
		}
		if attempt < 2 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
	return lastErr
}

func newEventID() (string, error) {
	bytesValue := make([]byte, 16)
	if _, err := rand.Read(bytesValue); err != nil {
		return "", err
	}
	bytesValue[6] = (bytesValue[6] & 0x0f) | 0x40
	bytesValue[8] = (bytesValue[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		bytesValue[0:4], bytesValue[4:6], bytesValue[6:8], bytesValue[8:10], bytesValue[10:16]), nil
}

func readMemInfo() (*float64, *float64, *float64) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return nil, nil, nil
	}
	values := map[string]float64{}
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		value, err := strconv.ParseFloat(parts[1], 64)
		if err == nil {
			values[strings.TrimSuffix(parts[0], ":")] = value
		}
	}
	total, ok := values["MemTotal"]
	available, availableOK := values["MemAvailable"]
	if !ok || !availableOK || total <= 0 {
		return nil, nil, nil
	}
	used := total - available
	percent := round(used / total * 100)
	return floatPtr(round(total / 1024)), floatPtr(round(used / 1024)), &percent
}

func readTemperature() *float64 {
	paths := []string{"/sys/class/thermal/thermal_zone0/temp", "/sys/class/hwmon/hwmon0/temp1_input"}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
		if err == nil {
			return floatPtr(round(value / 1000))
		}
	}
	return nil
}

func readUptime() *int {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return nil
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return nil
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return nil
	}
	seconds := int(value)
	return &seconds
}

func readLoad1M() *float64 {
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return nil
	}
	value, err := strconv.ParseFloat(strings.Fields(string(data))[0], 64)
	if err != nil {
		return nil
	}
	return floatPtr(round(value*100) / 100)
}

func readDiskPercent(path string) *float64 {
	// Statfs is kept in a tiny Linux-specific helper below; returning nil here
	// keeps this file easy to test on non-Linux development machines.
	value, err := diskPercent(path)
	if err != nil {
		return nil
	}
	return floatPtr(round(value))
}

func readCPUTimes() *cpuTimes {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 9 || parts[0] != "cpu" {
			continue
		}
		var result cpuTimes
		for i := 0; i < 8; i++ {
			value, parseErr := strconv.ParseUint(parts[i+1], 10, 64)
			if parseErr != nil {
				return nil
			}
			result.values[i] = value
		}
		return &result
	}
	return nil
}

func cpuPercent(previous, current *cpuTimes) *float64 {
	if previous == nil || current == nil {
		return nil
	}
	var previousTotal, currentTotal, previousIdle, currentIdle uint64
	for i, value := range previous.values {
		previousTotal += value
		currentTotal += current.values[i]
	}
	previousIdle = previous.values[3] + previous.values[4]
	currentIdle = current.values[3] + current.values[4]
	totalDelta := currentTotal - previousTotal
	if totalDelta == 0 {
		return nil
	}
	percent := round((1 - float64(currentIdle-previousIdle)/float64(totalDelta)) * 100)
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	return &percent
}

func platformName() string {
	data, err := os.ReadFile("/etc/os-release")
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"")
			}
		}
	}
	return "linux"
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil {
		return fallback
	}
	return value
}

func floatPtr(value float64) *float64 { return &value }
func round(value float64) float64     { return float64(int(value*10+0.5)) / 10 }

func formatPtr(value *float64) string {
	if value == nil {
		return "n/a"
	}
	return strconv.FormatFloat(*value, 'f', 1, 64)
}
