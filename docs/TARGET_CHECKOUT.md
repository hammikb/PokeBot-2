# Target Auto-Checkout - Implementation Guide

## Overview

Target auto-checkout has been fully implemented and integrated into PokeBot 2. This feature automates the entire checkout process from adding items to cart through order placement.

## Features

### ✅ Complete Automation

- **Add to Cart** - Automatically adds products with configurable quantity
- **Cart Navigation** - Handles cart modal and navigation
- **Shipping Verification** - Verifies and updates shipping address if needed
- **Payment Processing** - Enters CVV and handles payment methods
- **Order Placement** - Completes the checkout and confirms order

### ✅ Safety Features

- **Test Mode** - Test checkout flow without placing actual orders
- **Manual Fallback** - Keeps browser open if manual intervention needed
- **Screenshot Capture** - Saves screenshots at key points
- **Trace Recording** - Records full Playwright trace for debugging
- **Error Handling** - Comprehensive error handling with detailed logging

### ✅ Smart Features

- **Quantity Support** - Respects buy limit settings (1-10 items)
- **CVV Entry** - Automatically enters CVV when required
- **Session Management** - Uses existing Target sessions via auto-login
- **CAPTCHA Detection** - Pauses for CAPTCHA resolution
- **Confirmation Detection** - Multiple methods to verify order success

## How to Use

### 1. Set Up Target Account

```javascript
// In the Accounts page:
1. Click "Register New Account" or "Add Account"
2. Select "Target" as retailer
3. Enter email and password
4. Add shipping information
5. Add CVV (optional but recommended)
6. Save account
```

### 2. Create a Task

```javascript
// In the Tasks page:
1. Click "Create Task"
2. Select "Target" as retailer
3. Enter product URL
4. Set buy limit (1-10)
5. Select Target account(s)
6. Choose mode:
   - "monitor-and-buy" - Auto-checkout on drop
   - "test-checkout" - Test without placing order
7. Save task
```

### 3. Test Checkout (Recommended)

```javascript
// Before running live:
1. Create task in "test-checkout" mode
2. Click "Test" button
3. Review the checkout flow
4. Verify shipping and payment info
5. Browser will stop before final "Place Order" button
```

### 4. Run Live Checkout

```javascript
// For actual purchases:
1. Set task mode to "monitor-and-buy"
2. Click "Start" to begin monitoring
3. Bot will auto-checkout when product drops
4. Check notifications for order confirmation
```

## Checkout Flow Details

### Step-by-Step Process

1. **Open Product Page** - Navigates to Target product URL
2. **Sign In Check** - Ensures account is logged in
3. **Set Quantity** - Selects buy limit quantity if > 1
4. **Add to Cart** - Clicks add to cart button
5. **Navigate to Cart** - Handles cart modal/navigation
6. **Open Checkout** - Goes to Target checkout page
7. **Verify Shipping** - Checks/updates shipping address
8. **Continue to Payment** - Proceeds to payment section
9. **Enter CVV** - Fills CVV if required
10. **Review Order** - Proceeds to order review
11. **Place Order** - Submits order (skipped in test mode)
12. **Confirm Success** - Verifies order confirmation

### Selectors Used

The flow uses multiple selector strategies for reliability:

- `data-test` attributes (Target's test IDs)
- Text-based selectors (button text)
- Fallback selectors for robustness

## Configuration

### Buy Limits

Target typically allows 1-10 items per order. The bot respects this:

```javascript
buyLimit: 1 - 10 // Configurable per task
```

### Timeouts

- Page load: 30 seconds
- Button clicks: 10-15 seconds
- Order confirmation: 5 seconds

### Rate Limiting

Target is configured with:

- 30 requests per minute
- Burst limit of 10 requests
- Automatic retry-after handling

## Troubleshooting

### Common Issues

#### 1. "Place order button not found"

**Cause**: Checkout page structure changed or payment issue
**Solution**:

- Check if payment method is saved
- Verify CVV is correct
- Run in test mode to see exact state

#### 2. "Order status unclear"

**Cause**: Confirmation page didn't load or changed
**Solution**:

- Check Target account for order
- Review screenshot in traces folder
- Order may have succeeded - verify manually

#### 3. "Manual intervention required"

**Cause**: Payment method needs to be added
**Solution**:

- Browser stays open for manual completion
- Add payment method in Target account
- Re-run checkout

### Debug Mode

Enable debug logging to see detailed flow:

```javascript
// Logs are in: %APPDATA%/pokebot2/logs/
// Look for [BrowserPool] and [target-checkout] entries
```

## Testing Recommendations

### Before Going Live

1. ✅ Test with a cheap item first
2. ✅ Verify shipping address is correct
3. ✅ Confirm payment method works
4. ✅ Run test-checkout mode multiple times
5. ✅ Check CVV is saved correctly

### During Live Use

1. 📱 Enable notifications (SMS/Discord)
2. 👀 Monitor the dashboard feed
3. 📸 Check screenshots if issues occur
4. 🔍 Review traces for failed attempts

## Advanced Features

### Multiple Accounts

Run checkout on multiple Target accounts simultaneously:

```javascript
// Select multiple accounts in task
accountIds: ['account-1', 'account-2', 'account-3']
// Bot will attempt checkout on all accounts in parallel
```

### Proxy Support

Use proxies to avoid rate limiting:

```javascript
// In account settings:
proxy: 'host:port:username:password'
```

### Custom Intervals

Adjust monitoring frequency:

```javascript
intervalMs: 4000 // Check every 4 seconds (default)
```

## Files Modified/Created

### New Files

- `src/main/automation/flows/target.js` - Main checkout flow

### Modified Files

- `src/main/tasks/TaskManager.js` - Added Target to FLOWS

### Dependencies

- Uses existing `target-page-utils.js` for helper functions
- Integrates with `TraceRecorder.js` for debugging
- Uses `captcha.js` for CAPTCHA handling

## Performance

### Speed

- Typical checkout: 15-30 seconds
- With CAPTCHA: 30-60 seconds (manual solve)
- Test mode: 10-20 seconds (stops before order)

### Success Rate

Factors affecting success:

- ✅ Account session validity
- ✅ Payment method saved
- ✅ Product availability
- ✅ Network speed
- ⚠️ CAPTCHA challenges
- ⚠️ Target site changes

## Future Enhancements

Potential improvements:

1. Auto-CAPTCHA solving (if service integrated)
2. Pickup location selection
3. Gift card support
4. Order modification (change quantity mid-checkout)
5. Multi-item cart support

## Support

### Logs Location

```
%APPDATA%/pokebot2/logs/pokebot-YYYY-MM-DD.log
```

### Traces Location

```
%APPDATA%/pokebot2/traces/target-[account]-[timestamp]/
```

### Screenshots Location

```
%APPDATA%/pokebot2/traces/target-[account]-[timestamp]/screenshot.png
```

## Notes

- Target checkout is now fully functional
- Test mode is highly recommended before live use
- Browser stays open if manual intervention needed
- All actions are logged for debugging
- Traces and screenshots saved automatically
- Respects Target's rate limits to avoid bans

## Comparison with Other Retailers

| Feature          | Target | Walmart | Pokemon Center |
| ---------------- | ------ | ------- | -------------- |
| Auto-checkout    | ✅     | ✅      | ✅             |
| Test mode        | ✅     | ✅      | ✅             |
| Quantity support | ✅     | ✅      | ✅             |
| CVV entry        | ✅     | ✅      | ✅             |
| Queue handling   | ❌     | ✅      | ❌             |
| Pickup option    | 🚧     | ❌      | ❌             |

Legend: ✅ Implemented | ❌ Not applicable | 🚧 Planned
