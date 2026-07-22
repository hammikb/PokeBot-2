# Walmart MCP Server Setup

## What You Installed

You've installed `@striderlabs/mcp-walmart` - an MCP server that provides Walmart tools.

## How to Configure It for Cline

To let me (Cline) access the Walmart MCP server tools, you need to add it to your MCP configuration:

### Step 1: Find Your MCP Config File

The config file is located at:

```
%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json
```

Or navigate to:

```
C:\Users\kaib1\AppData\Roaming\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json
```

### Step 2: Add Walmart MCP Server

Open the file and add this configuration:

```json
{
  "mcpServers": {
    "walmart": {
      "command": "npx",
      "args": ["@striderlabs/mcp-walmart"]
    }
  }
}
```

If the file already has other servers, add the walmart entry:

```json
{
  "mcpServers": {
    "existing-server": {
      "command": "...",
      "args": ["..."]
    },
    "walmart": {
      "command": "npx",
      "args": ["@striderlabs/mcp-walmart"]
    }
  }
}
```

### Step 3: Restart VS Code

After saving the config:

1. Close VS Code completely
2. Reopen VS Code
3. The Walmart MCP server will be available

### Step 4: Verify It's Working

Once configured, I'll be able to:

- See what tools the Walmart MCP provides
- Use those tools to interact with Walmart
- Analyze how it bypasses detection
- Integrate those techniques into PokeBot

## What I'll Do Next

Once you configure it, I can:

1. **List available tools**:
   - See what Walmart operations it supports
   - Check if it has add-to-cart, checkout, etc.

2. **Analyze the implementation**:
   - See what API endpoints it uses
   - Check authentication methods
   - Study stealth techniques

3. **Integrate into PokeBot**:
   - Apply successful techniques
   - Update our Walmart API client
   - Make checkout work reliably

## Quick Setup

1. Press `Win + R`
2. Paste: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings`
3. Press Enter
4. Open `cline_mcp_settings.json`
5. Add the walmart server config above
6. Save and restart VS Code

Then let me know and I'll analyze the MCP server!
