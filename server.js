// Porchbook call server.
// - Rings members and passes call setup messages (never sees call audio/video or keys)
// - Keeps the "who's online" list
// - Hands each member the STUN/TURN settings (so TURN passwords aren't in the site's code)
// - Serves the widget at /porchbook-calls.js so the Porchbook site needs one <script> tag
//
// Env vars (set these on Render or wherever you host it):
//   PORT              set automatically by most hosts
//   ALLOWED_ORIGINS   comma list, default "https://pmmporchbook.grok.me"
//   TURN_URLS         comma list, e.g. "turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp"
//   TURN_USERNAME     from your TURN provider
//   TURN_CREDENTIAL   from your TURN provider

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
// porchbook.vercel.app is always allowed: it is the live Porchbook site.
const ALLOWED_ORIGINS = ["https://porchbook.vercel.app", ...(process.env.ALLOWED_ORIGINS || "https://pmmporchbook.grok.me")
  .split(",").map((s) => s.trim()).filter(Boolean)];

const ICE_SERVERS = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
if (process.env.TURN_URLS) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URLS.split(",").map((s) => s.trim()),
    username: process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  });
}

// Works whether the widget sits next to server.js or inside a "public" folder.
const WIDGET_PATH = [path.join(__dirname, "porchbook-calls.js"), path.join(__dirname, "public", "porchbook-calls.js")]
  .find((p) => fs.existsSync(p)) || path.join(__dirname, "porchbook-calls.js");
const users = new Map(); // handle (lowercase) -> socket
const FORWARD = new Set(["ring", "accept", "decline", "busy", "offer", "answer", "ice", "hangup"]);

const originOk = (origin) =>
  !origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin) ||
  /^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/porchbook-calls.js")) {
    fs.readFile(WIDGET_PATH, (err, data) => {
      if (err) { res.writeHead(500); return res.end("widget missing"); }
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      });
      res.end(data);
    });
    return;
  }
  if (req.url === "/demo") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="background:#000;color:#fff;font-family:system-ui;padding:24px">
<h2>Porchbook calls test page</h2><p>Open this page in two tabs or two phones and call each other.</p>
<script src="/porchbook-calls.js"></script></body>`);
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Porchbook call server is running");
});

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin }) => originOk(origin),
  maxPayload: 64 * 1024,
});

function broadcastPresence() {
  const online = [...users.values()].map((ws) => ({ id: ws.userId, name: ws.displayName }));
  const msg = JSON.stringify({ type: "presence", online });
  for (const ws of users.values()) ws.send(msg);
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "register") {
      const name = String(msg.name || msg.userId || "").trim().replace(/\s+/g, " ").slice(0, 30);
      if (name.length < 2) return ws.send(JSON.stringify({ type: "register-error", reason: "Name too short" }));
      const id = name.toLowerCase();
      const existing = users.get(id);
      if (existing && existing !== ws && existing.readyState === existing.OPEN) {
        return ws.send(JSON.stringify({ type: "register-error", reason: "That name is already online. Pick another." }));
      }
      // NOTE: Porchbook has no accounts yet, so names are first-come. When you add
      // login, check the member's login token here instead.
      if (ws.userId && ws.userId !== id) users.delete(ws.userId);
      ws.userId = id;
      ws.displayName = name;
      users.set(id, ws);
      ws.send(JSON.stringify({ type: "registered", userId: id, name, iceServers: ICE_SERVERS }));
      broadcastPresence();
      return;
    }

    if (!ws.userId || !FORWARD.has(msg.type) || typeof msg.to !== "string") return;
    const target = users.get(msg.to);
    if (!target || target.readyState !== target.OPEN) {
      if (msg.type === "ring") ws.send(JSON.stringify({ type: "unavailable", callId: msg.callId, from: msg.to }));
      return;
    }
    target.send(JSON.stringify({ ...msg, from: ws.userId, fromName: ws.displayName }));
  });

  ws.on("close", () => {
    if (ws.userId && users.get(ws.userId) === ws) {
      users.delete(ws.userId);
      broadcastPresence();
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log(`Porchbook call server on :${PORT}`));
