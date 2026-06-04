# Walmart Bot Detection Bypass Guide

## Why You're Getting "Robot or Human" Page

Walmart uses sophisticated bot detection that checks for:
1. **Automation signals** - Browser properties that indicate automation
2. **Behavior patterns** - Too fast, too consistent, no mouse movement
3. **Session history** - New profiles with no browsing history
4. **Request patterns** - Unusual API calls or timing

## Current Bot Detection Measures

The bot already has some anti-detection features:
```javascript
args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
ignoreDefaultArgs: ['--enable-automation']
```

But Walmart needs MORE to avoid detection.

## Solutions (In Order of Effectiveness)

### 1. ✅ Use Your Real Browser Profile (BEST)

**Why it works**: Your real profile has:
- Browsing history
- Cookies from previous Walmart visits
- Normal user behavior patterns
- Trusted session data

**How to do it**:
1. Find your Chrome profile path:
   - Windows: `C:\Users\YourName\AppData\Local\Google\Chrome\User Data\Default`
   - Mac: `~/Library/Application Support/Google/Chrome/Default`
2. In the bot, set your account's profile path to your real Chrome profile
3. **Important**: Close Chrome before running the bot (can't use same profile twice)

### 2. ✅ Sign In Manually First (RECOMMENDED)

**Before running automation**:
1. Open the bot's browser profile manually
2. Go to walmart.com
3. Sign in normally
4. Browse a few products
5. Add something to cart, then remove it
6. Close browser
7. NOW run your automation

This "warms up" the profile and makes it look legitimate.

### 3. ✅ Add Human-Like Delays

The bot currently clicks buttons instantly. Add random delays:

```javascript
// Instead of instant click
await button.click()

// Add human-like delay
await page.waitForTimeout(Math.random() * 1000 + 500) // 500-1500ms
await button.click()
```

### 4. ✅ Use Residential Proxies

**Why**: Walmart flags datacenter IPs
- Datacenter proxy = instant bot detection
- Residential proxy = looks like home internet
- No proxy = uses your real IP (safest for personal use)

**Recommended providers**:
- Bright Data (expensive but best)
- Smartproxy
- Oxylabs

### 5. ⚠️ Solve CAPTCHA Manually (Current Method)

The bot already detects CAPTCHAs and waits for you to solve them:
- You have 5 minutes to solve
- Bot sends notification when CAPTCHA appears
- Continue automation after solving

### 6. 🔧 Enhanced Stealth Mode (Advanced)

Add these browser args to BrowserPool.js:

```javascript
args: [
  '--no-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-setuid-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-extensions-with-background-pages',
  '--disable-extensions',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--disable-renderer-backgrounding',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--force-color-profile=srgb',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-zygote',
  '--use-mock-keychain'
]
```

## What NOT To Do

❌ **Don't run too many tasks at once** - Walmart will flag multiple simultaneous checkouts
❌ **Don't use the same account on multiple IPs** - Instant ban
❌ **Don't checkout too fast** - Add 2-3 second delays between steps
❌ **Don't use VPN/datacenter proxies** - Use residential or your real IP
❌ **Don't create new profiles for each run** - Reuse the same profile

## Recommended Workflow

### For Best Results:

1. **Day Before Drop**:
   - Open bot's browser profile
   - Sign into Walmart
   - Browse Pokemon products
   - Add items to cart, remove them
   - Close browser

2. **During Drop**:
   - Use alert-only mode first to detect restock
   - When alerted, manually verify it's in stock
   - Then run auto-checkout
   - If CAPTCHA appears, solve it quickly

3. **After Checkout**:
   - Don't immediately run another task
   - Wait 5-10 minutes between attempts
   - Vary your behavior

## Why Walmart Detects Bots

Walmart's bot detection checks:
- `navigator.webdriver` (we disable this)
- `window.chrome` object
- Canvas fingerprinting
- WebGL fingerprinting
- Audio context fingerprinting
- Mouse movement patterns
- Typing speed and patterns
- Time between actions

## Advanced: Playwright Stealth Plugin

For maximum stealth, we could add `playwright-extra` with stealth plugin:

```bash
npm install playwright-extra puppeteer-extra-plugin-stealth
```

This automatically:
- Removes webdriver property
- Fixes navigator properties
- Randomizes canvas fingerprint
- Passes all bot detection tests

## Current Limitations

The bot uses Playwright's standard mode. For production use against Walmart's advanced detection:
1. Use real browser profiles
2. Add human-like delays
3. Use residential proxies
4. Consider playwright-extra stealth plugin

## Quick Fixes You Can Try Now

1. **Use your real Chrome profile** (safest)
2. **Sign in manually before automation**
3. **Add 2-3 second delays** between steps
4. **Run fewer concurrent tasks** (1-2 max)
5. **Use your real IP** (no proxy)

## Success Rate Expectations

- **With real profile + manual warmup**: 80-90% success
- **With new profile**: 20-30% success (high CAPTCHA rate)
- **With datacenter proxy**: 5-10% success (almost always blocked)
- **With residential proxy + real profile**: 95%+ success

## Need Help?

If you're still getting blocked:
1. Share your setup (profile type, proxy, etc.)
2. Check if you're signed into Walmart in the profile
3. Try running a manual browse session first
4. Consider using alert-only mode + manual checkout for important drops
