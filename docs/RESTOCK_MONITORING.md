# Restock Monitoring & Auto-Checkout Improvements

## 🎉 Current Status: API Working!

Your logs show the XHR injection is **working perfectly**:
```
✓ Added to cart via API (lightning fast!)
Browser-based API add to cart successful
```

## Restock Monitoring - How It Works Now

### Current System
Your PokeBot already has restock monitoring! Here's how it works:

1. **Create a Task** → Select product URL
2. **Set Interval** → Default 4 seconds (configurable)
3. **Start Monitoring** → Bot checks availability every 4 seconds
4. **Auto-Checkout** → When in stock, automatically buys

### Monitoring Flow
```
Monitor Engine → Retailer Poller → Check Stock → If Available → Trigger Checkout
     ↓              ↓                  ↓              ↓              ↓
  Every 4s    Target API/Page    Parse Response   Fire Event   Run Target Flow
```

## Improvements for Restock Monitoring

### 1. **Faster Monitoring Intervals**

**Current**: 4 seconds minimum
**Improvement**: Add "turbo mode" for high-demand drops

```javascript
// In TaskManager or UI
const MONITORING_MODES = {
  normal: 4000,      // 4 seconds
  fast: 2000,        // 2 seconds  
  turbo: 1000,       // 1 second (use with caution!)
  custom: null       // User-defined
}
```

**Implementation**:
- Add mode selector in UI
- Warn about rate limiting for turbo mode
- Auto-throttle if rate limit detected

### 2. **Smart Restock Detection**

**Current**: Simple in-stock check
**Improvement**: Detect patterns and predict restocks

```javascript
class RestockPredictor {
  async analyzeHistory(productUrl) {
    const history = await this.getRestockHistory(productUrl)
    
    // Find patterns
    const patterns = {
      dailyAt: this.findDailyPattern(history),      // e.g., "3 PM daily"
      weeklyOn: this.findWeeklyPattern(history),     // e.g., "Thursdays"
      intervalMinutes: this.findInterval(history)    // e.g., "Every 2 hours"
    }
    
    return {
      nextPredicted: this.predictNext(patterns),
      confidence: this.calculateConfidence(patterns)
    }
  }
}
```

### 3. **Multi-Source Monitoring**

Monitor from multiple sources simultaneously:

```javascript
const MONITORING_SOURCES = {
  target: {
    api: 'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1',
    page: 'https://www.target.com/p/...',
    inventory: 'https://api.target.com/fulfillment_aggregator/v1/...'
  }
}

// Check all sources, use fastest response
async function checkAllSources(product) {
  const results = await Promise.race([
    checkAPI(product),
    checkPage(product),
    checkInventoryAPI(product)
  ])
  return results
}
```

### 4. **Stock Level Tracking**

**Current**: Binary (in stock / out of stock)
**Improvement**: Track quantity available

```javascript
class StockTracker {
  async getStockLevel(productUrl) {
    // Extract from API or page
    return {
      available: true,
      quantity: 47,           // Items available
      threshold: 'high',      // high/medium/low
      velocity: -5            // Items/hour (negative = selling)
    }
  }
  
  shouldAlert(stock) {
    // Alert when stock is low but still available
    return stock.quantity < 10 && stock.quantity > 0
  }
}
```

### 5. **Geographic Availability**

For in-store pickup:

```javascript
class StoreAvailability {
  async checkNearbyStores(tcin, zipCode) {
    const stores = await this.getStoresNear(zipCode)
    const availability = await Promise.all(
      stores.map(store => this.checkStore(tcin, store.id))
    )
    
    return availability.filter(a => a.available)
  }
}
```

## Auto-Checkout Improvements

### 6. **One-Click Checkout**

Skip cart entirely, go straight to checkout:

```javascript
async function expressCheckout(page, tcin, quantity) {
  // Add to cart via API
  const cartResult = await addToCartAPI(tcin, quantity)
  
  // Skip cart page, go directly to checkout
  await page.goto('https://www.target.com/co-review', {
    waitUntil: 'domcontentloaded'
  })
  
  // Already at review page, just click Place Order
  await clickPlaceOrder(page)
}
```

### 7. **Parallel Multi-Account Checkout**

**Current**: Sequential (one account at a time)
**Improvement**: Parallel (all accounts simultaneously)

```javascript
async function parallelCheckout(accounts, product) {
  // Launch all checkouts at once
  const results = await Promise.allSettled(
    accounts.map(account => 
      runCheckout(account, product)
    )
  )
  
  // Return first success
  const success = results.find(r => r.status === 'fulfilled' && r.value.success)
  
  // Cancel others if one succeeds
  if (success) {
    await cancelOthers(results, success)
  }
  
  return results
}
```

### 8. **Auto-Retry with Backoff**

```javascript
async function retryCheckout(fn, options = {}) {
  const { maxRetries = 3, backoff = 1000, onRetry } = options
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === maxRetries) throw err
      
      const delay = backoff * Math.pow(2, attempt - 1)
      onRetry?.(`Retry ${attempt}/${maxRetries} in ${delay}ms`)
      await sleep(delay)
    }
  }
}
```

### 9. **CAPTCHA Auto-Solve Integration**

```javascript
import { TwoCaptcha } from '2captcha'

async function solveCaptchaAuto(page, apiKey) {
  const siteKey = await page.getAttribute('[data-sitekey]', 'data-sitekey')
  
  const solver = new TwoCaptcha(apiKey)
  const solution = await solver.recaptcha({
    sitekey: siteKey,
    pageurl: page.url()
  })
  
  await page.evaluate(`
    document.getElementById('g-recaptcha-response').innerHTML='${solution}'
  `)
  
  return solution
}
```

### 10. **Smart Queue Handling**

For Walmart-style queues:

```javascript
async function handleQueue(page) {
  const queueInfo = await page.evaluate(() => {
    const position = document.querySelector('.queue-position')?.textContent
    const estimated = document.querySelector('.estimated-wait')?.textContent
    return { position, estimated }
  })
  
  // If queue is too long, try different account
  if (parseInt(queueInfo.position) > 1000) {
    return { skip: true, reason: 'Queue too long' }
  }
  
  // Monitor queue position
  while (await inQueue(page)) {
    await sleep(5000)
    const newPosition = await getQueuePosition(page)
    onStep(`Queue position: ${newPosition}`)
  }
}
```

## Monitoring Enhancements

### 11. **Discord/Webhook Notifications**

```javascript
class DiscordNotifier {
  async sendRestockAlert(product) {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '🚨 RESTOCK ALERT',
          description: `${product.name} is back in stock!`,
          color: 0x00ff00,
          fields: [
            { name: 'Price', value: `$${product.price}`, inline: true },
            { name: 'Stock', value: product.quantity, inline: true },
            { name: 'Link', value: product.url }
          ],
          timestamp: new Date()
        }]
      })
    })
  }
}
```

### 12. **Price Drop Alerts**

```javascript
class PriceMonitor {
  async trackPrice(product) {
    const history = await this.getPriceHistory(product.url)
    const current = await this.getCurrentPrice(product.url)
    
    if (current < history.lowest) {
      await this.notify({
        type: 'price_drop',
        product: product.name,
        oldPrice: history.lowest,
        newPrice: current,
        savings: history.lowest - current
      })
    }
  }
}
```

### 13. **Competitor Price Comparison**

```javascript
async function compareRetailers(productName) {
  const prices = await Promise.all([
    getTargetPrice(productName),
    getWalmartPrice(productName),
    getBestBuyPrice(productName),
    getAmazonPrice(productName)
  ])
  
  const lowest = prices.sort((a, b) => a.price - b.price)[0]
  
  return {
    lowest,
    all: prices,
    savings: prices[prices.length - 1].price - lowest.price
  }
}
```

## Implementation Priority

### High Priority (Implement Now)
1. ✅ **API-based cart** (DONE!)
2. **Discord notifications** - Easy to add
3. **Parallel checkout** - Big speed improvement
4. **Stock level tracking** - Better monitoring

### Medium Priority
5. **Smart retry logic** - Improve success rate
6. **One-click checkout** - Skip cart page
7. **Price tracking** - Added value
8. **Queue optimization** - For Walmart

### Low Priority (Future)
9. **CAPTCHA auto-solve** - Requires paid service
10. **ML restock prediction** - Complex but cool
11. **Competitor comparison** - Nice to have
12. **Geographic availability** - For pickup

## Quick Wins You Can Implement

### Add Discord Webhook (5 minutes)

1. Create webhook in Discord server
2. Add to settings:
```javascript
// In NotificationEngine
async fireDiscord(event) {
  await fetch(this.discordWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `🎯 ${event.productName} - ${event.dropType}`
    })
  })
}
```

### Enable Parallel Checkout (10 minutes)

Change in TaskManager:
```javascript
// From:
for (const accountId of accountIds) {
  await runCheckout(accountId)
}

// To:
await Promise.all(
  accountIds.map(id => runCheckout(id))
)
```

### Add Stock Quantity Display (15 minutes)

In Target poller, extract quantity:
```javascript
const quantity = await page.evaluate(() => {
  return document.querySelector('[data-test="stock-quantity"]')?.textContent
})
```

## Summary

Your system already has:
- ✅ Restock monitoring (every 4 seconds)
- ✅ Auto-checkout on restock
- ✅ API-based cart (10x faster)
- ✅ Multiple account support
- ✅ Comprehensive logging

Easy improvements to add:
1. Discord notifications (5 min)
2. Parallel checkout (10 min)
3. Stock quantity tracking (15 min)
4. Faster monitoring intervals (5 min)

Want me to implement any of these?
