# discord-mcp

A small, self-hosted [MCP](https://modelcontextprotocol.io) server on Cloudflare Workers that lets an AI assistant (for example a custom connector in Claude) read and post on Discord as **your own bot**: forum posts with tags and images, messages, replies and edits.

The bot token stays in Cloudflare's secret storage and never appears in a chat. On purpose, there are **no delete, lock, archive or moderation tools**, and every message is sent with pings disabled.

## Tools

| Tool | What it does |
|---|---|
| `discord_whoami` | The bot's own user |
| `discord_list_servers` | Servers the bot is in (filtered by the allow-list) |
| `discord_list_channels` | Channels of a server |
| `discord_get_channel` | One channel: description, forum tags, … |
| `discord_find_forum_posts` | Active and archived posts in a forum, optionally by title |
| `discord_read_messages` | Recent messages of a channel or thread (max 50) |
| `discord_create_forum_post` | New forum post with title, text and tags |
| `discord_send_message` | Message in a channel or thread, optionally as a reply |
| `discord_prepare_upload` | Signed, short-lived link to send a post or message with files |
| `discord_edit_message` | Edit one of the bot's own messages |
| `discord_update_forum_post` | Change title or tags of one of the bot's own posts |

### File uploads

MCP tool calls can't carry files well, so `discord_prepare_upload` returns a link to this Worker that is valid for 10 minutes and bound (HMAC-signed) to exactly the post or message described. The assistant then `POST`s the files there as multipart `files[0]`, `files[1]`, …; the Worker checks the signature and the allow-list again and forwards everything to Discord. The machine that uploads must be able to reach your `*.workers.dev` domain.

## Setup

### 1. A Discord bot
In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application**, give it a name (and optionally an icon and description under **General Information**).
2. **Installation**: set **Install Link** to **None** and keep only **Guild Install** checked. (Discord won't let you make a bot private while it has an install link.)
3. **Bot**:
   - Set the bot's username.
   - Turn **Public Bot** off, so only you can add it to servers.
   - Leave **Requires OAuth2 Code Grant** off.
   - Leave all **Privileged Gateway Intents** off; the server only uses Discord's REST API.
   - **Reset Token** and keep the token somewhere safe. Discord shows it only once.
4. **OAuth2 → URL Generator**: scope `bot`, integration type **Guild Install**, and these permissions only:
   View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files, Read Message History.
   Open the generated URL and add the bot to your server.

Give it no moderation permissions (Manage Messages, Manage Threads, …): the bot can always edit its own messages and posts without them, and without them it can't remove anything written by others. You can limit it further per channel with the bot's role in your server's channel settings.

### 2. Deploy the Worker
Either fork this repository and connect it in the Cloudflare dashboard (**Workers & Pages → Create → Continue with GitHub**, deploy command `npx wrangler deploy`), or create a "Hello World" Worker and paste `worker.js` into the editor. The Worker name must match `name` in `wrangler.toml` when deploying from Git.

### 3. Settings
Worker → **Settings → Variables and Secrets**:

| Name | Type | Value |
|---|---|---|
| `DISCORD_TOKEN` | Secret | the bot token (without `Bot ` in front) |
| `CONNECTOR_SECRET` | Secret | a random string, at least 32 letters/digits; it becomes part of the address |
| `UPLOAD_SIGNING_KEY` | Secret | another random string, at least 32 characters |
| `ALLOWED_IDS` | Text | optional: comma-separated server and/or channel IDs |

`ALLOWED_IDS`: a server ID allows all its channels; a channel or category ID also allows its threads and forum posts. Empty means everything the bot can see. `wrangler.toml` sets `keep_vars = true`, so Git deploys don't overwrite it.

### 4. Connect your assistant
The MCP endpoint (streamable HTTP, no OAuth) is:

```
https://<worker-name>.<your-subdomain>.workers.dev/mcp/<CONNECTOR_SECRET>
```

In Claude: **Settings → Connectors → Add custom connector** and paste the address. Treat it like a password: whoever has it can post as your bot.

For image uploads from Claude's sandbox, also allow the Worker's domain there (claude.ai **Settings → Capabilities → Domain allowlist**, and the allowed domains of a cloud environment).

## Security notes
- `GET /health` shows which settings exist and their lengths (never values), plus the first 8 hex characters of the SHA-256 of `CONNECTOR_SECRET`, so you can check that the Worker has the secret you think it has. In PowerShell: `$h=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($secret)); -join ($h[0..3] | % { $_.ToString('x2') })`
- Wrong path → `404`. `GET`/`DELETE` on the endpoint → `405`.
- If the address leaks, change `CONNECTOR_SECRET`; nothing else is affected.
- If Discord answers `401`, the token was reset: update `DISCORD_TOKEN`.
- Mentions (`@everyone`, roles, users) never ping.

## Tests
`node test.mjs` runs the Worker against a mocked Discord API (Node 18+).
