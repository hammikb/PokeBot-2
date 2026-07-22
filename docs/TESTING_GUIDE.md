# 🧪 PokeBot 2 - Comprehensive Testing Guide

## 📋 Overview

This guide will help you test all the new features added in the recent improvements.

---

## ✅ Pre-Testing Checklist

Before starting tests:

- [ ] App starts without errors (`npm run dev`)
- [ ] No console errors on startup
- [ ] Database initialized successfully
- [ ] All pages load (Dashboard, Accounts, Tasks, Settings)

---

## 🎯 Feature Testing

### 1. Live Progress Streaming ✅

**What it does**: Shows real-time progress updates for tasks

**How to test**:

1. Create a task (any retailer)
2. Start the task
3. Watch for progress updates in the UI
4. Check console for progress events

**Expected behavior**:

- Progress bar updates in real-time
- Step messages appear (e.g., "Checking stock", "Adding to cart")
- Duration counter increments
- Success/error messages display

**Logs to check**:

```
[ProgressStreamer] Stream started
[ProgressStreamer] Step: {message}
[ProgressStreamer] Stream completed
```

---

### 2. Profile Warmup Automation ✅

**What it does**: Simulates 3 minutes of human browsing on Walmart

**How to test**:

1. Go to **Accounts** page
2. Find a Walmart account
3. Click **"warm up (3min)"** button
4. Watch the browser automation

**Expected behavior**:

- Browser opens to Walmart.com
- Performs 8-15 random actions:
  - Searches for products
  - Clicks on items
  - Scrolls pages
  - Hovers over elements
  - Types like a human (random delays)
- Takes ~3 minutes
- Signs in automatically
- Closes browser when done

**Success indicators**:

- ✅ "Profile warmup completed successfully"
- ✅ Account status updates
- ✅ No errors in console

**Logs to check**:

```
[ProfileWarmup] Starting warmup
[ProfileWarmup] Action 1/12: search
[ProfileWarmup] Action 2/12: click
[ProfileWarmup] Warmup completed
```

---

### 3. Smart Retry System ✅

**What it does**: Intelligently retries failed operations with error classification

**How to test**:

1. Create a task with invalid product URL
2. Start the task
3. Watch it fail and retry
4. Check error classification

**Expected behavior**:

- Classifies error type (network, timeout, bot detection, etc.)
- Applies appropriate delay based on error
- Provides recommendations
- Tracks failure patterns

**Error types to look for**:

- `RATE_LIMIT` - 30-60s delay
- `BOT_DETECTION` - 60-120s delay
- `NETWORK_ERROR` - 5-10s delay
- `TIMEOUT` - 10-20s delay
- `CAPTCHA` - 120-300s delay

**Logs to check**:

```
[SmartRetry] Attempt 1 failed: {error}
[SmartRetry] Error classified as: RATE_LIMIT
[SmartRetry] Applying delay: 45000ms
[SmartRetry] Recommendation: Use profile warmup
```

---

### 4. Proxy Health Monitoring ✅

**What it does**: Automatically monitors proxy health and disables bad ones

**How to test**:

1. Add some proxies in Settings
2. The system will auto-check them every 1 minute
3. Watch for health status updates

**Expected behavior**:

- Checks all proxies every 60 seconds
- Tracks success/failure rates
- Calculates response times
- Auto-disables after 3 consecutive failures
- Status levels: unknown → healthy → degraded → unhealthy → disabled

**To manually test**:

```javascript
// In DevTools console (F12)
// This would be exposed via IPC in production
```

**Logs to check**:

```
[ProxyHealthMonitor] Starting proxy health monitoring
[ProxyHealthMonitor] Checking proxy health {count: 5}
[ProxyHealthMonitor] Proxy check succeeded {proxy: xxx, responseTime: 250ms}
[ProxyHealthMonitor] Proxy status changed {proxy: xxx, status: healthy}
[ProxyHealthMonitor] Proxy disabled {proxy: xxx, reason: 3 consecutive failures}
```

---

### 5. Cookie Management ✅

**What it does**: Generates and rotates cookies to bypass detection

**How to test**:

1. Start a task
2. Watch for cookie generation in logs
3. Check browser cookies

**Expected behavior**:

- Generates retailer-specific cookies
- Walmart: \_pxvid, \_px3, akavpau_vp_walmart, ACID
- Target: visitorId, TealeafAkaSid, UserLocation
- Validates cookies before use
- Rotates cookies when needed

**Logs to check**:

```
[CookieManager] Generating fresh cookies {retailer: walmart}
[CookieManager] Generated Walmart cookies {count: 4}
[CookieManager] Cookies validated successfully
[CookieManager] Cookie rotation complete
```

---

### 6. Comprehensive Debugging ✅

**What it does**: Tracks all operations with detailed metrics

**How to test**:

1. Enable debug mode: `DEBUG=true npm run dev`
2. Perform any operation
3. Check logs and metrics

**Expected behavior**:

- Session tracking for each task
- Event logging with timestamps
- Error tracking with stack traces
- Performance metrics
- Export debug data to JSON

**Debug data location**:

- Logs: `%APPDATA%/pokebot2/logs/`
- Debug exports: `%APPDATA%/pokebot2/debug/`

**Logs to check**:

```
[DebugManager] Debug session started {sessionId: xxx}
[DebugManager] [xxx] Event: Adding to cart
[DebugManager] [xxx] Error: {message, stack}
[DebugManager] Debug session ended {duration: 5000ms}
```

---

## 🔍 Integration Testing

### Test Scenario 1: Complete Task Flow

**Steps**:

1. Create Walmart account
2. Warm up profile (3 min)
3. Create task for Pokemon product
4. Start task
5. Watch progress stream
6. Observe retry logic if it fails
7. Check debug logs

**Expected**:

- ✅ Profile warmup completes
- ✅ Progress updates in real-time
- ✅ Smart retry on failures
- ✅ Cookies generated
- ✅ Debug session tracked

---

### Test Scenario 2: Proxy Management

**Steps**:

1. Add 5 proxies (mix of good and bad)
2. Wait for health checks
3. Watch status changes
4. See bad proxies get disabled

**Expected**:

- ✅ All proxies checked
- ✅ Success rates calculated
- ✅ Bad proxies auto-disabled
- ✅ Only healthy proxies used

---

### Test Scenario 3: Error Recovery

**Steps**:

1. Create task with rate-limited URL
2. Start task
3. Watch smart retry classify error
4. See adaptive delays
5. Get recommendations

**Expected**:

- ✅ Error classified correctly
- ✅ Appropriate delay applied
- ✅ Recommendation provided
- ✅ Pattern analysis shown

---

## 📊 Performance Testing

### Metrics to Track

**Response Times**:

- Profile warmup: ~3 minutes
- Cookie generation: <100ms
- Proxy health check: <5 seconds
- Smart retry delay: Varies by error type

**Resource Usage**:

- Memory: Should stay under 500MB
- CPU: Spikes during browser automation
- Network: Depends on task frequency

---

## 🐛 Known Issues & Workarounds

### Issue 1: ConfigManager Disabled

**Status**: Temporarily disabled due to build issues  
**Impact**: Cannot import/export config files  
**Workaround**: Manual account/task creation  
**Fix**: Will be re-implemented later

### Issue 2: PokemonFinder Disabled

**Status**: Auto-scan disabled to reduce noise  
**Impact**: No automatic Pokemon item scanning  
**Workaround**: Manual product monitoring  
**Fix**: Can be re-enabled if needed

---

## ✅ Testing Checklist

### Basic Functionality

- [ ] App starts without errors
- [ ] Can create accounts
- [ ] Can create tasks
- [ ] Can start/stop tasks
- [ ] Settings save correctly

### New Features

- [ ] Profile warmup works (3 min test)
- [ ] Progress streaming shows updates
- [ ] Smart retry classifies errors
- [ ] Proxy monitoring tracks health
- [ ] Cookies are generated
- [ ] Debug logs are created

### Error Handling

- [ ] Invalid URLs handled gracefully
- [ ] Network errors trigger retry
- [ ] Bad proxies get disabled
- [ ] Error messages are clear

### Performance

- [ ] No memory leaks
- [ ] Responsive UI
- [ ] Fast startup time
- [ ] Smooth animations

---

## 📝 Test Results Template

```markdown
## Test Results - [Date]

### Environment

- OS: Windows 11
- Node: v20.x
- Electron: v32.x

### Tests Performed

1. Profile Warmup: ✅ PASS
   - Duration: 3:05 minutes
   - Actions: 12
   - Result: Success

2. Smart Retry: ✅ PASS
   - Error classified: RATE_LIMIT
   - Delay applied: 45s
   - Recommendation shown: Yes

3. Proxy Monitoring: ✅ PASS
   - Proxies checked: 5
   - Healthy: 3
   - Disabled: 2

### Issues Found

- None

### Notes

- All features working as expected
- Performance is good
- No errors in console
```

---

## 🎯 Success Criteria

**All tests pass if**:

- ✅ App starts without errors
- ✅ Profile warmup completes successfully
- ✅ Progress streaming works in real-time
- ✅ Smart retry classifies errors correctly
- ✅ Proxy monitoring auto-disables bad proxies
- ✅ Cookies are generated for each retailer
- ✅ Debug logs are comprehensive
- ✅ No memory leaks or crashes
- ✅ UI remains responsive

---

## 🚀 Next Steps After Testing

1. Document any bugs found
2. Test edge cases
3. Performance optimization if needed
4. Re-enable ConfigManager (optional)
5. Production deployment

---

## 📞 Support

If you encounter issues:

1. Check logs in `%APPDATA%/pokebot2/logs/`
2. Export debug data
3. Review error classifications
4. Check proxy health stats

**Debug Mode**: `DEBUG=true npm run dev`

---

_Last Updated: June 3, 2026_  
_Version: 2.0_  
_Status: Ready for Testing_ ✅
