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
Worker → **Settings → Variables and Secrets** (the runtime section, *not* **Settings → Build → Variables and secrets**, which the running Worker never sees). Add them for **Production**, then **Deploy**:

| Name | Type | Value |
|---|---|---|
| `DISCORD_TOKEN` | Secret | the bot token (without `Bot ` in front) |
| `CONNECTOR_SECRET` | Secret | a random string of at least 32 letters/digits only; it becomes part of the address, so symbols like `/ # ? % +` break it |
| `UPLOAD_SIGNING_KEY` | Secret | another random string, at least 32 characters |
| `ALLOWED_IDS` | Text | optional: comma-separated server and/or channel IDs |

`ALLOWED_IDS`: a server ID allows all its channels; a channel or category ID also allows its threads and forum posts. Empty means everything the bot can see. `wrangler.toml` sets `keep_vars = true`, so Git deploys don't overwrite it; you can ignore the dashboard's hint to add it to your Wrangler configuration. Whitespace around pasted values is ignored.

Generating a secret (64 hex characters), with any of:

```sh
openssl rand -hex 32
```
```powershell
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })
```
```js
// browser console
[...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
```

### 4. Connect your assistant
The MCP endpoint (streamable HTTP, no OAuth) is:

```
https://<worker-name>.<your-subdomain>.workers.dev/mcp/<CONNECTOR_SECRET>
```

Quick test before connecting (should list 11 tools):

```sh
curl -s -X POST "https://<worker-name>.<your-subdomain>.workers.dev/mcp/<CONNECTOR_SECRET>" \
  -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

In Claude: **Settings → Connectors → Add custom connector** and paste the address. Claude reports that it couldn't determine how the server signs in, because there is no sign-in: choose **Continue anyway**, leave the OAuth fields empty, then **Connect**. Treat the address like a password: whoever has it can post as your bot.

For image uploads from Claude's sandbox, also allow the Worker's domain there (claude.ai **Settings → Capabilities → Domain allowlist**, and the allowed domains of a cloud environment). This applies to chats started afterwards.

## Troubleshooting
- **`Not found` at the right address:** open `https://<worker-name>.<your-subdomain>.workers.dev/health`. It shows which settings exist and their lengths (never values), plus the first 8 hex characters of the SHA-256 of `CONNECTOR_SECRET`, to compare with your copy:
  - everything `"set": false` → the variables were added under **Build**, or not deployed; add them under **Settings → Variables and Secrets**.
  - fingerprint differs → the Worker has a different secret than your address; paste it again.
  - fingerprint of your copy in PowerShell: `$h=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($secret)); -join ($h[0..3] | % { $_.ToString('x2') })`, or `printf %s "$SECRET" | sha256sum | cut -c1-8`.
- **Discord answers `401`:** the token was reset or is wrong; update `DISCORD_TOKEN`.
- **"not on this connector's allow-list":** add the server or channel ID to `ALLOWED_IDS`.
- **Image upload refused by Claude's sandbox:** the Worker's domain isn't in the allowlist (see step 4), or the chat was started before you added it.

## Security notes
- Without the secret, every path answers `404`, except `/health` and `/upload` (which rejects anything without a valid, unexpired signed link). `GET`/`DELETE` on the endpoint → `405`.
- The Worker logs nothing and never returns secret values; `/health` only reveals lengths and a short fingerprint.
- If the address leaks, change `CONNECTOR_SECRET` and update the connector; nothing else is affected.
- Mentions (`@everyone`, roles, users) never ping.

## Tests
`node test.mjs` runs the Worker against a mocked Discord API (Node 18+).
