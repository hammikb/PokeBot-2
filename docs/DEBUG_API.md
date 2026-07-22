# How to Debug and Fix Target API Integration

## Step-by-Step Guide to Make XHR Injection Work

### Step 1: Capture Real Target API Request

1. **Open Target.com in Chrome**
   - Go to https://www.target.com
   - Sign in to your account

2. **Open DevTools**
   - Press `F12` or `Ctrl+Shift+I`
   - Go to **Network** tab
   - Check "Preserve log"
   - Filter by "Fetch/XHR"

3. **Add Item to Cart**
   - Find any product
   - Click "Add to cart"
   - Watch the Network tab

4. **Find the Cart Request**
   - Look for request to `carts.target.com/web_checkouts/v1/cart_items`
   - Click on it
   - Copy the following:

### Step 2: What to Copy

#### Request Headers

```
Right-click request → Copy → Copy as fetch (Node.js)
```

Look for these important headers:

- `cookie:` - All cookies
- `x-application-name:` - Usually "web"
- `x-csrf-token:` - CSRF protection token
- `authorization:` - If present
- `user-agent:` - Browser identifier

#### Request Payload

Click "Payload" tab and copy the JSON body:

```json
{
  "cart_type": "REGULAR",
  "channel_id": "10",
  "shopping_context": "DIGITAL",
  "cart_item": {
    "tcin": "12345678",
    "quantity": 1,
    "item_channel_id": "10"
  }
}
```

### Step 3: Update the Code

Open `src/main/automation/api/targetApi.js` and update:

#### Update Headers (Line ~195)

```javascript
_getHeaders() {
  const cookieString = Object.entries(this.cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')

  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    'Cookie': cookieString,
    'Referer': 'https://www.target.com/',
    'Origin': 'https://www.target.com',
    // ADD THESE FROM YOUR CAPTURED REQUEST:
    'x-application-name': 'web',
    'x-csrf-token': this.cookies['csrf-token'] || '',  // Check actual cookie name
    'x-requested-with': 'XMLHttpRequest'
  }
}
```

#### Update API Key (Line ~207)

```javascript
_getApiKey() {
  // Replace with the key from your captured request
  // Look in the URL: ?key=XXXXX
  return 'YOUR_CAPTURED_API_KEY_HERE'
}
```

### Step 4: Alternative - Use Playwright to Execute API

Instead of axios, use Playwright's page.evaluate to run the API call in the browser context:

```javascript
// In target.js, add this method:
async function apiAddToCartInBrowser(page, tcin, quantity) {
  try {
    const result = await page.evaluate(
      async ({ tcin, quantity }) => {
        const response = await fetch('https://carts.target.com/web_checkouts/v1/cart_items', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-application-name': 'web'
          },
          body: JSON.stringify({
            cart_type: 'REGULAR',
            channel_id: '10',
            shopping_context: 'DIGITAL',
            cart_item: {
              tcin: tcin,
              quantity: quantity,
              item_channel_id: '10'
            }
          })
        })

        if (!response.ok) {
          return { success: false, error: `HTTP ${response.status}` }
        }

        const data = await response.json()
        return { success: true, data }
      },
      { tcin, quantity }
    )

    return result
  } catch (err) {
    return { success: false, error: err.message }
  }
}
```

This runs the fetch **inside the browser** so it has all the right cookies and context!

### Step 5: Test the Fix

1. **Update the code** with captured headers
2. **Rebuild**: `npm run build`
3. **Test**: Run a Target checkout
4. **Check logs**: Look for "✓ Added to cart via API"

### Step 6: Common Issues & Solutions

#### Issue: 400 Bad Request

**Solution**: Missing or wrong headers

- Check CSRF token
- Verify API key
- Match all headers from captured request

#### Issue: 401 Unauthorized

**Solution**: Authentication problem

- Ensure cookies are being sent
- Check if session is valid
- May need to refresh cookies

#### Issue: 403 Forbidden

**Solution**: CORS or security block

- Use the browser-based approach (page.evaluate)
- Ensures same origin and context

### Quick Win: Browser-Based API (Recommended)

This is the easiest and most reliable approach:

```javascript
// In src/main/automation/flows/target.js
// Replace the API section with:

if (useApi) {
  try {
    onStep(`Adding ${buyLimit} item(s) to cart via API...`)

    // Execute API call IN the browser context
    const result = await page.evaluate(
      async ({ tcin, quantity }) => {
        try {
          const response = await fetch('https://carts.target.com/web_checkouts/v1/cart_items', {
            method: 'POST',
            credentials: 'include', // Important!
            headers: {
              'Content-Type': 'application/json',
              'x-application-name': 'web'
            },
            body: JSON.stringify({
              cart_type: 'REGULAR',
              channel_id: '10',
              shopping_context: 'DIGITAL',
              cart_item: {
                tcin: tcin,
                quantity: quantity,
                item_channel_id: '10'
              }
            })
          })

          if (!response.ok) {
            const text = await response.text()
            return { success: false, error: `${response.status}: ${text}` }
          }

          const data = await response.json()
          return { success: true, cartId: data.cart_id }
        } catch (err) {
          return { success: false, error: err.message }
        }
      },
      { tcin, quantity: buyLimit }
    )

    if (result.success) {
      onStep('✓ Added to cart via API (lightning fast!)')
      log.info('Browser API add to cart successful', { cartId: result.cartId })

      // Navigate to checkout
      await page.goto('https://www.target.com/co-cart', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      })
    } else {
      onStep('API failed, using browser fallback')
      log.warn('Browser API failed', { error: result.error })
      await browserAddToCart(page, buyLimit, onStep, notificationEngine, dropEvent)
    }
  } catch (err) {
    onStep('API error, using browser fallback')
    log.error('Browser API error', { error: err.message })
    await browserAddToCart(page, buyLimit, onStep, notificationEngine, dropEvent)
  }
}
```

### Why Browser-Based API is Better

1. **Automatic cookies** - Browser handles all authentication
2. **Same origin** - No CORS issues
3. **Auto CSRF** - Browser includes tokens automatically
4. **Always current** - Uses Target's current API
5. **Still fast** - ~500ms vs 5-10s for clicking

### Next Steps

1. Try the browser-based approach first (easiest)
2. If that works, you're done!
3. If not, capture the real request and update headers
4. Test and iterate

Want me to implement the browser-based API approach for you? It's the most reliable method!
