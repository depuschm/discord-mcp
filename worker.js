/**
 * Discord connector for Claude: a small MCP server for Cloudflare Workers.
 *
 * - Speaks MCP over "streamable HTTP" (stateless JSON responses), no dependencies.
 * - Reachable only under a secret path:  https://<worker>/mcp/<CONNECTOR_SECRET>
 * - Talks to Discord as your bot; the bot token is a Cloudflare secret (DISCORD_TOKEN).
 * - There is deliberately NO delete tool, and no tool that locks, archives or moderates.
 * - Optional allow-list (ALLOWED_IDS): server and/or channel IDs the connector may touch.
 *
 * Settings (Cloudflare dashboard > Worker > Settings > Variables and Secrets):
 *   DISCORD_TOKEN       secret  the bot token
 *   CONNECTOR_SECRET    secret  long random string; part of the connector URL
 *   UPLOAD_SIGNING_KEY  secret  long random string; signs the short-lived upload links
 *   ALLOWED_IDS         text    optional, comma-separated server/channel IDs. Empty = everything the bot can see.
 *                               A server ID allows all its channels; a channel ID also allows its threads/posts;
 *                               a category ID allows the channels in it.
 */

const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://claude.ai, 1.0)";
const SERVER_INFO = { name: "discord-mcp", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const UPLOAD_LINK_MINUTES = 10;
const ID = /^\d{17,20}$/;

const INSTRUCTIONS = [
  "Tools for posting to Discord as the owner's bot.",
  "Before creating or editing anything, show the user the exact post (where, title, text, tags, attachments) and wait for their explicit go.",
  "Deleting, locking, archiving and moderation are not available through this connector.",
  "To attach files: call discord_prepare_upload, then POST the files as multipart/form-data (fields files[0], files[1], ... in the announced order) to the returned upload_url within 10 minutes.",
].join(" ");

// ------------------------------------------------------------------ tool definitions

const idProp = (what) => ({ type: "string", pattern: "^\\d{17,20}$", description: what });

const TOOLS = [
  {
    name: "discord_whoami",
    title: "Who am I",
    description: "Returns the bot account this connector posts as.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "discord_list_servers",
    title: "List servers",
    description: "Lists the Discord servers the bot is in (filtered by the allow-list).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "discord_list_channels",
    title: "List channels",
    description: "Lists the channels of a server that the bot can see (filtered by the allow-list), with type and description.",
    inputSchema: { type: "object", properties: { server_id: idProp("Server (guild) ID") }, required: ["server_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "discord_get_channel",
    title: "Get channel",
    description: "Returns a channel's details: name, type, description (topic) and, for forum channels, the available tags with their IDs.",
    inputSchema: { type: "object", properties: { channel_id: idProp("Channel, forum or thread ID") }, required: ["channel_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "discord_find_forum_posts",
    title: "Find forum posts",
    description: "Lists posts (threads) in a forum channel, active and archived, optionally filtered by text in the title.",
    inputSchema: {
      type: "object",
      properties: {
        forum_channel_id: idProp("Forum channel ID"),
        title_contains: { type: "string", description: "Optional case-insensitive filter on the post title" },
      },
      required: ["forum_channel_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "discord_read_messages",
    title: "Read messages",
    description: "Reads recent messages from a channel or thread (newest first). Without the message-content intent, Discord only returns the text of the bot's own messages and of messages that mention it.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: idProp("Channel or thread ID"),
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        before: idProp("Optional: only messages older than this message ID"),
      },
      required: ["channel_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "discord_create_forum_post",
    title: "Create forum post (text only)",
    description: "Creates a new post in a forum channel without attachments. For posts with images use discord_prepare_upload instead. Only call after the user approved the exact post.",
    inputSchema: {
      type: "object",
      properties: {
        forum_channel_id: idProp("Forum channel ID"),
        title: { type: "string", minLength: 1, maxLength: 100 },
        content: { type: "string", minLength: 1, maxLength: 2000 },
        tag_ids: { type: "array", items: idProp("Tag ID"), maxItems: 5, description: "Forum tag IDs (see discord_get_channel)" },
      },
      required: ["forum_channel_id", "title", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "discord_send_message",
    title: "Send message (text only)",
    description: "Sends a text message to a channel or into a thread/forum post, optionally as a reply. For messages with images use discord_prepare_upload. Only call after the user approved the exact message.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: idProp("Channel or thread ID"),
        content: { type: "string", minLength: 1, maxLength: 2000 },
        reply_to_message_id: idProp("Optional: message to reply to"),
      },
      required: ["channel_id", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "discord_prepare_upload",
    title: "Prepare a post or message with files",
    description:
      "Returns a short-lived signed upload_url for a forum post or message with attachments. The link is bound to exactly these fields and expires in 10 minutes. " +
      "Then POST multipart/form-data to upload_url with the files as files[0], files[1], ... in the same order as 'filenames'. Only call after the user approved the exact post.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["forum_post", "message"] },
        channel_id: idProp("Forum channel ID (forum_post) or channel/thread ID (message)"),
        title: { type: "string", maxLength: 100, description: "Required for forum_post" },
        content: { type: "string", maxLength: 2000 },
        tag_ids: { type: "array", items: idProp("Tag ID"), maxItems: 5 },
        reply_to_message_id: idProp("Optional, for kind=message"),
        filenames: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 10, description: "File names in upload order; the first image becomes a forum post's image" },
      },
      required: ["kind", "channel_id", "filenames"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "discord_edit_message",
    title: "Edit message text",
    description: "Replaces the text of one of the bot's own messages. Attachments stay. For a forum post's first message, channel_id and message_id are both the post's ID. Only call when the user asked for the edit.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: idProp("Channel or thread ID"),
        message_id: idProp("Message ID"),
        content: { type: "string", minLength: 1, maxLength: 2000 },
      },
      required: ["channel_id", "message_id", "content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "discord_update_forum_post",
    title: "Change a forum post's title or tags",
    description: "Changes the title and/or tags of a forum post the bot created. Only call when the user asked for the change.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: idProp("Forum post (thread) ID"),
        title: { type: "string", minLength: 1, maxLength: 100 },
        tag_ids: { type: "array", items: idProp("Tag ID"), maxItems: 5 },
      },
      required: ["post_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

// ------------------------------------------------------------------ helpers

class ToolError extends Error {}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...extra } });
}

function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text))));
}

function requireId(v, what) {
  if (typeof v !== "string" || !ID.test(v)) throw new ToolError(`${what} must be a Discord ID (17-20 digits).`);
  return v;
}
function requireText(v, what, max, min = 1) {
  if (typeof v !== "string" || v.length < min || v.length > max) throw new ToolError(`${what} must be ${min}-${max} characters.`);
  return v;
}

const NO_PINGS = { parse: [] };

// ------------------------------------------------------------------ Discord client

class Discord {
  constructor(env) {
    if (!env.DISCORD_TOKEN) throw new ToolError("DISCORD_TOKEN is not set on the Worker.");
    this.token = env.DISCORD_TOKEN;
    this.allowed = new Set(String(env.ALLOWED_IDS || "").split(/[\s,]+/).filter(Boolean));
    this.channelCache = new Map();
  }

  async call(method, path, body, isForm = false) {
    const headers = { Authorization: `Bot ${this.token}`, "User-Agent": UA };
    let payload;
    if (body !== undefined) {
      if (isForm) payload = body;
      else { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    }
    const res = await fetch(API + path, { method, headers, body: payload });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
    if (res.status === 429) throw new ToolError(`Discord rate limit: retry after ${data && data.retry_after} seconds.`);
    if (!res.ok) {
      const hint = res.status === 401 ? " (the bot token on the Worker is wrong or was reset)" : res.status === 403 ? " (the bot lacks permission here)" : "";
      throw new ToolError(`Discord error ${res.status}${hint}: ${data && data.message ? data.message : text.slice(0, 200)}`);
    }
    return data;
  }

  async channel(id) {
    if (!this.channelCache.has(id)) this.channelCache.set(id, await this.call("GET", `/channels/${id}`));
    return this.channelCache.get(id);
  }

  get restricted() { return this.allowed.size > 0; }

  async channelAllowed(id) {
    if (!this.restricted) return true;
    if (this.allowed.has(id)) return true;
    const ch = await this.channel(id);
    if (ch.guild_id && this.allowed.has(ch.guild_id)) return true;
    if (ch.parent_id) {
      if (this.allowed.has(ch.parent_id)) return true;
      const parent = await this.channel(ch.parent_id);         // thread in a channel inside an allowed category
      if (parent.parent_id && this.allowed.has(parent.parent_id)) return true;
    }
    return false;
  }

  async assertChannel(id) {
    if (!(await this.channelAllowed(id))) throw new ToolError(`Channel ${id} is not on this connector's allow-list (ALLOWED_IDS).`);
  }

  async allowedGuildIds() {
    const ids = new Set();
    for (const id of this.allowed) {
      try { const ch = await this.channel(id); if (ch.guild_id) ids.add(ch.guild_id); }
      catch { ids.add(id); }                                    // not a channel: treat as a server ID
    }
    return ids;
  }
}

const summarizeChannel = (c) => ({
  id: c.id, name: c.name, type: c.type, parent_id: c.parent_id || null,
  topic: c.topic ? (c.topic.length > 200 ? c.topic.slice(0, 200) + "…" : c.topic) : null,
});

// ------------------------------------------------------------------ tool implementations

const handlers = {
  async discord_whoami(d) {
    const me = await d.call("GET", "/users/@me");
    return { id: me.id, username: me.username, discriminator: me.discriminator, bot: me.bot, allow_list: d.restricted ? [...d.allowed] : "none (everything the bot can see)" };
  },

  async discord_list_servers(d) {
    const guilds = await d.call("GET", "/users/@me/guilds");
    let list = guilds.map((g) => ({ id: g.id, name: g.name }));
    if (d.restricted) { const ok = await d.allowedGuildIds(); list = list.filter((g) => ok.has(g.id)); }
    return list;
  },

  async discord_list_channels(d, a) {
    const gid = requireId(a.server_id, "server_id");
    const channels = await d.call("GET", `/guilds/${gid}/channels`);
    for (const c of channels) d.channelCache.set(c.id, { ...c, guild_id: gid });
    const out = [];
    for (const c of channels) if (await d.channelAllowed(c.id)) out.push(summarizeChannel(c));
    if (d.restricted && out.length === 0) throw new ToolError(`Nothing in server ${gid} is on the allow-list.`);
    return out;
  },

  async discord_get_channel(d, a) {
    const id = requireId(a.channel_id, "channel_id");
    await d.assertChannel(id);
    const c = await d.channel(id);
    return {
      id: c.id, name: c.name, type: c.type, server_id: c.guild_id, parent_id: c.parent_id || null,
      topic: c.topic || null,
      available_tags: (c.available_tags || []).map((t) => ({ id: t.id, name: t.name, moderated: t.moderated })),
      applied_tags: c.applied_tags || undefined,
      owner_id: c.owner_id || undefined,
    };
  },

  async discord_find_forum_posts(d, a) {
    const fid = requireId(a.forum_channel_id, "forum_channel_id");
    await d.assertChannel(fid);
    const forum = await d.channel(fid);
    const active = await d.call("GET", `/guilds/${forum.guild_id}/threads/active`);
    let posts = active.threads.filter((t) => t.parent_id === fid);
    let before = null;
    for (let page = 0; page < 10; page++) {
      const q = `/channels/${fid}/threads/archived/public?limit=100` + (before ? `&before=${encodeURIComponent(before)}` : "");
      const res = await d.call("GET", q);
      posts = posts.concat(res.threads);
      if (!res.has_more || res.threads.length === 0) break;
      before = res.threads[res.threads.length - 1].thread_metadata.archive_timestamp;
    }
    const needle = (a.title_contains || "").toLowerCase();
    return posts
      .filter((t) => !needle || t.name.toLowerCase().includes(needle))
      .map((t) => ({ id: t.id, title: t.name, owner_id: t.owner_id, applied_tags: t.applied_tags || [], archived: !!(t.thread_metadata && t.thread_metadata.archived), message_count: t.message_count }));
  },

  async discord_read_messages(d, a) {
    const id = requireId(a.channel_id, "channel_id");
    await d.assertChannel(id);
    const limit = Math.min(Math.max(parseInt(a.limit || 20, 10) || 20, 1), 50);
    const before = a.before ? `&before=${requireId(a.before, "before")}` : "";
    const msgs = await d.call("GET", `/channels/${id}/messages?limit=${limit}${before}`);
    return msgs.map((m) => ({
      id: m.id, author: m.author && m.author.username, author_id: m.author && m.author.id, timestamp: m.timestamp,
      content: m.content, attachments: (m.attachments || []).map((x) => x.filename), edited: !!m.edited_timestamp,
    }));
  },

  async discord_create_forum_post(d, a) {
    const fid = requireId(a.forum_channel_id, "forum_channel_id");
    await d.assertChannel(fid);
    const body = {
      name: requireText(a.title, "title", 100),
      message: { content: requireText(a.content, "content", 2000), allowed_mentions: NO_PINGS },
    };
    if (a.tag_ids && a.tag_ids.length) body.applied_tags = a.tag_ids.map((t) => requireId(t, "tag_id")).slice(0, 5);
    const thread = await d.call("POST", `/channels/${fid}/threads`, body);
    return postResult(thread);
  },

  async discord_send_message(d, a) {
    const id = requireId(a.channel_id, "channel_id");
    await d.assertChannel(id);
    const body = { content: requireText(a.content, "content", 2000), allowed_mentions: NO_PINGS };
    if (a.reply_to_message_id) body.message_reference = { message_id: requireId(a.reply_to_message_id, "reply_to_message_id"), fail_if_not_exists: false };
    const m = await d.call("POST", `/channels/${id}/messages`, body);
    return messageResult(m, await d.channel(id));
  },

  async discord_prepare_upload(d, a, ctx) {
    if (!ctx.env.UPLOAD_SIGNING_KEY) throw new ToolError("UPLOAD_SIGNING_KEY is not set on the Worker.");
    const kind = a.kind;
    if (kind !== "forum_post" && kind !== "message") throw new ToolError("kind must be forum_post or message.");
    const id = requireId(a.channel_id, "channel_id");
    await d.assertChannel(id);
    const filenames = Array.isArray(a.filenames) ? a.filenames : [];
    if (filenames.length < 1 || filenames.length > 10) throw new ToolError("filenames must list 1-10 files.");
    filenames.forEach((f) => requireText(f, "filename", 200));
    const job = { k: kind, c: id, f: filenames, x: Date.now() + UPLOAD_LINK_MINUTES * 60000 };
    if (kind === "forum_post") job.t = requireText(a.title, "title", 100);
    if (a.content) job.m = requireText(a.content, "content", 2000);
    if (kind === "forum_post" && !job.m && filenames.length === 0) throw new ToolError("A forum post needs content or files.");
    if (a.tag_ids && a.tag_ids.length) job.g = a.tag_ids.map((t) => requireId(t, "tag_id")).slice(0, 5);
    if (kind === "message" && a.reply_to_message_id) job.r = requireId(a.reply_to_message_id, "reply_to_message_id");
    const data = b64url(new TextEncoder().encode(JSON.stringify(job)));
    const sig = await hmac(ctx.env.UPLOAD_SIGNING_KEY, data);
    const url = new URL(ctx.request.url);
    return {
      upload_url: `${url.origin}/upload?d=${data}&s=${sig}`,
      expires_in_minutes: UPLOAD_LINK_MINUTES,
      how: "POST multipart/form-data to upload_url with fields files[0]..files[n-1] in this order: " + filenames.join(", "),
    };
  },

  async discord_edit_message(d, a) {
    const cid = requireId(a.channel_id, "channel_id"), mid = requireId(a.message_id, "message_id");
    await d.assertChannel(cid);
    const m = await d.call("PATCH", `/channels/${cid}/messages/${mid}`, { content: requireText(a.content, "content", 2000), allowed_mentions: NO_PINGS });
    return messageResult(m, await d.channel(cid));
  },

  async discord_update_forum_post(d, a) {
    const pid = requireId(a.post_id, "post_id");
    await d.assertChannel(pid);
    const body = {};
    if (a.title !== undefined) body.name = requireText(a.title, "title", 100);
    if (a.tag_ids !== undefined) body.applied_tags = a.tag_ids.map((t) => requireId(t, "tag_id")).slice(0, 5);
    if (!Object.keys(body).length) throw new ToolError("Give a new title and/or tag_ids.");
    const t = await d.call("PATCH", `/channels/${pid}`, body);   // only name/applied_tags: never archived/locked
    d.channelCache.set(pid, t);
    return { id: t.id, title: t.name, applied_tags: t.applied_tags || [] };
  },
};

function postResult(thread) {
  return {
    post_id: thread.id, title: thread.name, applied_tags: thread.applied_tags || [],
    starter_message_id: (thread.message && thread.message.id) || thread.id,
    attachments: thread.message && thread.message.attachments ? thread.message.attachments.map((x) => x.filename) : [],
    link: `https://discord.com/channels/${thread.guild_id}/${thread.id}`,
  };
}
function messageResult(m, ch) {
  return {
    message_id: m.id, channel_id: m.channel_id, attachments: (m.attachments || []).map((x) => x.filename),
    link: `https://discord.com/channels/${ch.guild_id}/${m.channel_id}/${m.id}`,
  };
}

// ------------------------------------------------------------------ signed uploads

async function handleUpload(request, env) {
  if (request.method !== "POST") return json({ error: "Use POST with multipart/form-data." }, 405);
  if (!env.UPLOAD_SIGNING_KEY) return json({ error: "Uploads are not configured." }, 500);
  const url = new URL(request.url);
  const data = url.searchParams.get("d") || "", sig = url.searchParams.get("s") || "";
  if (!data || !timingSafeEqual(sig, await hmac(env.UPLOAD_SIGNING_KEY, data))) return json({ error: "Invalid upload link." }, 403);
  let job;
  try { job = JSON.parse(new TextDecoder().decode(b64urlDecode(data))); } catch { return json({ error: "Invalid upload link." }, 403); }
  if (Date.now() > job.x) return json({ error: "This upload link has expired; prepare a new one." }, 410);

  let form;
  try { form = await request.formData(); } catch { return json({ error: "Body must be multipart/form-data." }, 400); }
  const files = job.f.map((_, i) => form.get(`files[${i}]`));
  if (files.some((f) => !f || typeof f === "string")) return json({ error: `Expected ${job.f.length} file(s) as files[0]..files[${job.f.length - 1}]: ${job.f.join(", ")}` }, 400);

  const attachments = job.f.map((name, i) => ({ id: i, filename: name }));
  const message = { allowed_mentions: NO_PINGS, attachments };
  if (job.m) message.content = job.m;
  const out = new FormData();
  let path;
  if (job.k === "forum_post") {
    const payload = { name: job.t, message };
    if (job.g) payload.applied_tags = job.g;
    out.append("payload_json", JSON.stringify(payload));
    path = `/channels/${job.c}/threads`;
  } else {
    if (job.r) message.message_reference = { message_id: job.r, fail_if_not_exists: false };
    out.append("payload_json", JSON.stringify(message));
    path = `/channels/${job.c}/messages`;
  }
  files.forEach((file, i) => out.append(`files[${i}]`, file, job.f[i]));

  try {
    const d = new Discord(env);
    await d.assertChannel(job.c);                               // allow-list may have changed since the link was made
    const res = await d.call("POST", path, out, true);
    return json(job.k === "forum_post" ? postResult(res) : messageResult(res, await d.channel(job.c)));
  } catch (e) {
    return json({ error: e.message }, e instanceof ToolError ? 502 : 500);
  }
}

// ------------------------------------------------------------------ MCP (JSON-RPC over HTTP)

async function handleRpc(msg, ctx) {
  const isNotification = msg.id === undefined || msg.id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params && msg.params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params && msg.params.name;
      const handler = handlers[name];
      if (!handler) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const d = new Discord(ctx.env);
        const result = await handler(d, (msg.params && msg.params.arguments) || {}, ctx);
        return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: Array.isArray(result) ? { items: result } : result, isError: false });
      } catch (e) {
        const text = e instanceof ToolError ? e.message : `Unexpected error: ${e && e.message}`;
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

async function handleMcp(request, env) {
  if (request.method === "GET" || request.method === "DELETE") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  let body;
  try { body = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const ctx = { env, request };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(m, ctx)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handleRpc(body, ctx);
  return out ? json(out) : new Response(null, { status: 202 });
}

export default {
  async fetch(request, rawEnv) {
    // Pasted secrets often carry an invisible trailing newline or space; ignore it.
    // The token may also have been pasted with its "Bot " prefix.
    const clean = (v) => (typeof v === "string" ? v.trim() : v);
    const env = {
      ...rawEnv,
      CONNECTOR_SECRET: clean(rawEnv.CONNECTOR_SECRET),
      UPLOAD_SIGNING_KEY: clean(rawEnv.UPLOAD_SIGNING_KEY),
      DISCORD_TOKEN: clean(rawEnv.DISCORD_TOKEN)?.replace(/^Bot\s+/i, ""),
      ALLOWED_IDS: clean(rawEnv.ALLOWED_IDS),
    };
    const url = new URL(request.url);
    if (url.pathname === "/upload") return handleUpload(request, env);
    const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (m && env.CONNECTOR_SECRET && env.CONNECTOR_SECRET.length >= 32 && timingSafeEqual(m[1], env.CONNECTOR_SECRET)) return handleMcp(request, env);
    return new Response("Not found", { status: 404 });          // everything else, including wrong secrets, looks the same
  },
};
