// ═══════════════════════════════════════════════════════════════
//  AXIOM Web Server — Production Ready
//  Deploy: Koyeb / Railway / Render
//  Local:  node server.js → http://localhost:3000
// ═══════════════════════════════════════════════════════════════

const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");
const path      = require("path");
const { OPCUAClient } = require("node-opcua");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Static files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Routes ───────────────────────────────────────────────────
app.get("/",          (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/dashboard", (_, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/health",    (_, res) => res.json({ status: "ok", app: "AXIOM", time: new Date() }));

// ── OPC-UA Sessions ──────────────────────────────────────────
const clientSessions = new Map();

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`🔗 Browser connected from ${ip}`);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── CONNECT ──────────────────────────────────────────────
    if (msg.type === "connect") {
      const { endpoint, tags, auth } = msg;
      console.log(`⟳  Connecting → ${endpoint} (${tags?.length} tags)`);
      await cleanupClient(ws);

      const client = OPCUAClient.create({
        endpointMustExist: false,
        connectionStrategy: { maxRetry: 3, initialDelay: 1000, maxDelay: 5000 }
      });

      try {
        await client.connect(endpoint);
        const session = await client.createSession(
          auth ? { userName: auth.user, password: auth.pass } : {}
        );
        console.log(`✅ OPC-UA connected — ${tags.length} tags`);

        const interval = setInterval(async () => {
          if (ws.readyState !== WebSocket.OPEN) { clearInterval(interval); return; }
          try {
            const results = await Promise.all(
              tags.map(t => session.readVariableValue(t.id))
            );
            const payload = tags.map((t, i) => ({
              ...t,
              value:   results[i]?.value?.value ?? null,
              quality: results[i]?.statusCode?.name ?? "Bad",
            }));
            send(ws, { type: "data", tags: payload });
          } catch (e) {
            send(ws, { type: "error", message: e.message });
          }
        }, 500);

        clientSessions.set(ws, { client, session, interval });
        send(ws, { type: "connected", endpoint, tagCount: tags.length });

      } catch (err) {
        console.error(`❌ OPC-UA failed: ${err.message}`);
        send(ws, { type: "connect_failed", message: err.message });
        try { await client.disconnect(); } catch {}
      }
    }

    if (msg.type === "disconnect") {
      await cleanupClient(ws);
      send(ws, { type: "disconnected" });
    }

    if (msg.type === "ping") send(ws, { type: "pong", time: Date.now() });
  });

  ws.on("close", () => { console.log("❌ Browser left"); cleanupClient(ws); });
  ws.on("error", (e) => { console.error("WS error:", e.message); cleanupClient(ws); });
});

async function cleanupClient(ws) {
  const s = clientSessions.get(ws);
  if (!s) return;
  clearInterval(s.interval);
  try { await s.session.close(); } catch {}
  try { await s.client.disconnect(); } catch {}
  clientSessions.delete(ws);
  console.log("🔌 Session cleaned up");
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(data));
}

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   AXIOM Industrial AI Monitor                ║");
  console.log(`║   Running on port ${PORT}                       ║`);
  console.log("║   /          → Landing page                  ║");
  console.log("║   /dashboard → Live dashboard                ║");
  console.log("║   /health    → Health check                  ║");
  console.log("╚══════════════════════════════════════════════╝\n");
});
