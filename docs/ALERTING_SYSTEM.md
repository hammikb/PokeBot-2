# Alerting System Documentation

## How Alerts Work

The PokeBot 2 alerting system follows industry-standard patterns used by professional sneaker/restock bots:

### Alert Flow

```
Product Detection → MonitorEngine → TaskManager → NotificationEngine → Multiple Channels
```

1. **TargetPoller** (or other retailer pollers) detect product availability
2. **MonitorEngine** receives drop events and emits them
3. **TaskManager._onDrop()** handles the event:
   - Emits to UI (line 100)
   - **Sends notifications** via NotificationEngine (line 101)
   - Handles task mode (alert-only, test-checkout, auto-checkout)
4. **NotificationEngine** sends alerts through multiple channels simultaneously

### Notification Channels

The bot supports **3 notification methods** (same as professional bots):

#### 1. Discord Webhooks 🎯
- **Industry standard** for restock bots
- Instant notifications to Discord servers
- Configured via `discordWebhook` setting
- Implementation: `src/main/notify/discord.js`

#### 2. SMS Alerts 📱
- Text message notifications via Twilio
- Configured via Twilio credentials
- Implementation: `src/main/notify/sms.js`

#### 3. Desktop Notifications 💻
- Native OS notifications
- Always enabled, no configuration needed
- Implementation: `src/main/notify/desktop.js`

### Task Modes

The bot supports 3 modes for handling detected products:

1. **alert-only**: Only sends notifications, no checkout
2. **test-checkout**: Sends alerts + attempts test checkout
3. **auto-checkout**: Sends alerts + attempts real checkout

### Alert Triggers

Alerts are sent when:
- ✅ Product comes IN_STOCK
- ✅ Price is within max_price limit
- ✅ First check (even if already in stock)
- ✅ Restock detected (was out, now in)

Alerts are NOT sent when:
- ❌ Product is OUT_OF_STOCK
- ❌ Price exceeds max_price
- ❌ Product stays in stock (no state change)

### Configuration

Set up notifications in the Settings page:

```javascript
{
  discordWebhook: "https://discord.com/api/webhooks/...",
  twilioSid: "AC...",
  twilioToken: "...",
  twilioFrom: "+1234567890",
  twilioTo: "+1234567890"
}
```

### Code References

- **NotificationEngine**: `src/main/notify/NotificationEngine.js`
- **Alert Trigger**: `src/main/tasks/TaskManager.js` (line 101)
- **Discord**: `src/main/notify/discord.js`
- **SMS**: `src/main/notify/sms.js`
- **Desktop**: `src/main/notify/desktop.js`

## Recent Fixes

### Scrapling stderr Issue (Fixed)

**Problem**: Scrapling outputs INFO logs to stderr, causing `execAsync` to throw errors. This prevented product detection even though the data was successfully fetched.

**Solution**: Added recovery logic in the catch block to:
1. Check if stderr contains actual errors vs INFO logs
2. Parse stdout despite stderr presence
3. Extract product data successfully

**Files Modified**: `src/main/monitor/retailers/target.js`

This fix ensures alerts work properly by allowing product detection to succeed.
