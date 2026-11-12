# Catalyst MCP connector: correct entries per host

c2c never edits these files. Paste the one for your host, replace `<dc-tld>` with your data centre's TLD, restart the host, then sign in to Zoho in the browser when asked.

| DC | `<dc-tld>` |
|---|---|
| IN | `in` (tested) |
| US | `com` |
| EU | `eu` |
| AU | `com.au` |
| CA | `ca` |
| SA | `sa` |
| JP | `jp` |

Tested data centre: IN (`https://catalystbyzoho.zohomcp.in/mcp/message`); the other rows follow the documented pattern. The official plugin 0.0.2 documents a second host family, `https://catalyst.zohomcp.<dc-tld>/mcp/message` (adds UAE: `ae`). If one does not list the Catalyst tools after sign-in, try the other; `/c2c:doctor` checks which tools you get.

Rules that avoid the "invalid MCP url" failure:
- The `url` must be a real URL. Never leave a placeholder such as `<YOUR_ZOHO_MCP_URL>`.
- Use `"type": "http"` (Claude Code also accepts `streamable-http`; other hosts may not).
- Do not add extra keys like `_note`.
- Keep only one Catalyst entry per host, on the DC of your Catalyst org.

## Claude Code (user scope)

```sh
claude mcp add --scope user --transport http catalyst-by-zoho https://catalystbyzoho.zohomcp.<dc-tld>/mcp/message
```

If the official plugin's own entry is broken, disable that copy first (`/plugin` → catalyst-by-zoho → disable, or fix its `.mcp.json`).

## OpenAI Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.catalyst-by-zoho]
url = "https://catalystbyzoho.zohomcp.<dc-tld>/mcp/message"
```
Then `codex mcp login catalyst-by-zoho` and finish the sign-in.

## Cursor (`.cursor/mcp.json` or `~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "catalyst-by-zoho": {
      "url": "https://catalystbyzoho.zohomcp.<dc-tld>/mcp/message"
    }
  }
}
```
Cursor's accepted `type` values for remote servers are [UNVERIFIED] (omit `type`; Cursor infers HTTP from `url`).

## Personal Zoho MCP servers (mcp.zoho.com)

A personal server URL embeds a token in its path (`https://<name>-<id>.zohomcp.<tld>/mcp/<token>/message`). Treat it like a password: do not paste it into chat or commit it. It exposes only the tools you selected; add **all** "Catalyst by Zoho" tools under Tools → Config Tools, or `/c2c:doctor` will fail D-B5.
