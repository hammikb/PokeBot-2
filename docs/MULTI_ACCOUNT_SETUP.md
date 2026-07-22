# Multi-Account Setup Guide for Walmart

## Goal

Run multiple Walmart accounts simultaneously to increase your chances of securing limited items.

## The Challenge

Each account needs its own:

- ✅ Browser profile (separate cookies/sessions)
- ✅ Walmart account credentials
- ✅ Payment method saved in Walmart
- ⚠️ Unique IP address (optional but recommended)
- ⚠️ Browsing history to avoid bot detection

## Step-by-Step Setup

### 1. Create Multiple Walmart Accounts

**You'll need**:

- Different email addresses (Gmail, Yahoo, etc.)
- Different payment methods OR same card with different billing addresses
- Different shipping addresses (friends/family)

**Create accounts**:

1. Go to walmart.com
2. Sign up with each email
3. Add payment method
4. Add shipping address
5. **Important**: Make a test purchase on each account to verify it works

### 2. Set Up Accounts in PokeBot

**For each Walmart account**:

1. **In PokeBot, go to Accounts tab**
2. **Click "Add Account"**
3. **Fill in details**:

   ```
   Name: Walmart-Account1
   Retailer: Walmart
   Email: your-email-1@gmail.com
   Password: your-password
   CVV: 123
   Profile Path: (leave default or customize)
   ```

4. **Repeat for each account**:
   - Walmart-Account2
   - Walmart-Account3
   - etc.

### 3. Warm Up Each Profile (CRITICAL!)

**For EACH account, do this**:

1. **Open the browser** (click "Open Browser" in Accounts tab)
2. **Go to walmart.com**
3. **Sign in with that account's credentials**
4. **Browse for 2-3 minutes**:
   - Search for Pokemon cards
   - Click on products
   - Add items to cart
   - Remove items from cart
   - View your orders
5. **Close the browser**
6. **Wait 5 minutes**
7. **Repeat for next account**

**Why this matters**: Walmart sees normal browsing history and trusts the profile.

### 4. Create Tasks for Each Account

**In the Tasks tab**:

1. **Create Task 1**:

   ```
   Product URL: [Walmart Pokemon product]
   Account: Walmart-Account1
   Mode: Auto-checkout
   Max Price: $50
   ```

2. **Create Task 2**:

   ```
   Product URL: [Same product]
   Account: Walmart-Account2
   Mode: Auto-checkout
   Max Price: $50
   ```

3. **Repeat for all accounts**

### 5. Run Multiple Tasks Simultaneously

**When the drop happens**:

1. Click "Start" on all tasks
2. Bot will run them in parallel (up to 3 at once by default)
3. First account to checkout wins!

## Profile Path Strategy

### Option A: Use Default Paths (Easiest)

- Bot creates separate profile for each account automatically
- Path: `AppData/Roaming/pokebot2/profiles/[account-id]`
- **Pro**: Easy, no setup
- **Con**: New profiles = higher bot detection

### Option B: Use Real Chrome Profiles (Best)

- Create separate Chrome profiles for each account
- Use those as profile paths
- **Pro**: Looks most legitimate
- **Con**: More setup required

**How to create Chrome profiles**:

1. Open Chrome
2. Click profile icon → "Add"
3. Create new profile (e.g., "Walmart1")
4. Find profile path:
   - Windows: `%LOCALAPPDATA%\Google\Chrome\User Data\Profile 1`
   - Mac: `~/Library/Application Support/Google/Chrome/Profile 1`
5. Set this path in PokeBot account settings

## IP Address Considerations

### Same IP for All Accounts (Your Home IP)

- **Pro**: Free, easy
- **Con**: Walmart may flag multiple checkouts from same IP
- **Recommendation**: Limit to 2-3 accounts max

### Different IPs (Residential Proxies)

- **Pro**: Each account looks independent
- **Con**: Costs $50-100/month
- **Recommendation**: For serious botting only

**How to add proxies**:

1. Buy residential proxies (Bright Data, Smartproxy)
2. In account settings, add proxy:
   ```
   Proxy: ip:port:username:password
   Example: 123.45.67.89:8080:user:pass
   ```

## Best Practices

### ✅ DO:

- Warm up each profile manually before automation
- Use different payment methods if possible
- Stagger task start times by 1-2 seconds
- Limit to 2-3 accounts on same IP
- Test each account with a cheap item first

### ❌ DON'T:

- Use same email for multiple accounts
- Run 10+ accounts on same IP
- Skip the manual warmup step
- Use brand new accounts without history
- Checkout too fast (add 2-3 second delays)

## Example: 3-Account Setup

**Account 1**:

- Email: john.doe1@gmail.com
- Profile: Real Chrome Profile 1
- Proxy: None (home IP)

**Account 2**:

- Email: john.doe2@gmail.com
- Profile: Real Chrome Profile 2
- Proxy: None (home IP)

**Account 3**:

- Email: jane.smith@gmail.com
- Profile: Real Chrome Profile 3
- Proxy: Residential proxy (optional)

**All warmed up manually, all have payment saved, all tested with small purchase.**

## Success Rate Expectations

### With Proper Setup:

- **1 account**: 30-40% success rate
- **2-3 accounts (same IP)**: 60-70% success rate
- **3-5 accounts (different IPs)**: 80-90% success rate

### Without Warmup:

- **Any number of accounts**: 5-10% success rate (bot detection)

## Troubleshooting

**"Robot or Human" on all accounts**:

- Profiles not warmed up properly
- Using new/empty profiles
- IP flagged by Walmart
- **Solution**: Manual warmup + use real Chrome profiles

**One account works, others don't**:

- Other accounts not signed in
- Other accounts not warmed up
- **Solution**: Warm up each account separately

**All accounts checkout same item**:

- This is expected! First one to complete wins
- Others will fail (item sold out)
- **Solution**: This is normal behavior

## Advanced: Profile Rotation

For maximum success:

1. Create 5-10 accounts
2. Warm up all profiles over several days
3. Rotate which accounts you use
4. Don't use same account twice in one day
5. Maintain browsing history on all profiles

## Cost Breakdown

**Free Setup** (2-3 accounts):

- Multiple Walmart accounts: Free
- Bot profiles: Free
- Home IP: Free
- **Total**: $0/month

**Pro Setup** (5+ accounts):

- Multiple Walmart accounts: Free
- Residential proxies: $50-100/month
- **Total**: $50-100/month

## Quick Start Checklist

- [ ] Create 2-3 Walmart accounts
- [ ] Add payment methods to each
- [ ] Make test purchase on each
- [ ] Add accounts to PokeBot
- [ ] Open browser for each account
- [ ] Sign in and browse for 2-3 minutes each
- [ ] Close browsers and wait
- [ ] Create tasks for each account
- [ ] Test with a cheap item first
- [ ] Ready for real drops!

## Final Tips

1. **Quality over quantity**: 2 well-warmed accounts > 10 new accounts
2. **Patience pays off**: Spend time warming up profiles
3. **Test first**: Always test with cheap items before important drops
4. **Stay legal**: Don't violate Walmart's terms too aggressively
5. **Have backups**: If one account gets banned, you have others

Good luck! 🎯
