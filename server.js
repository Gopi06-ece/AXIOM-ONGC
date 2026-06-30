// ═══════════════════════════════════════════════════════════════
//  AXIOM Web Server — v2 (Secure)
//  Adds: password login, OPC-UA auth passthrough, auto-reconnect
// ═══════════════════════════════════════════════════════════════

const express   = require("express");
const http      = require("http");
const WebSocket = require("ws");
const path      = require("path");
const crypto    = require("crypto");
const { OPCUAClient } = require("node-opcua");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ═══════════════════════════════════════════════════════
// ── ACCESS CODE (change this before deploying) ──────────
// ═══════════════════════════════════════════════════════
const ACCESS_CODE = process.env.AXIOM_ACCESS_CODE || "ongc2024";

// Active session tokens (simple in-memory store)
const validTokens = new Set();

function generateToken() {
  const token = crypto.randomBytes(24).toString("hex");
  validTokens.add(token);
  // Expire token after 12 hours
  setTimeout(() => validTokens.delete(token), 12 * 60 * 60 * 1000);
  return token;
}

// ── Static files (public pages don't need auth to be served, but data does) ──
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── Login endpoint ───────────────────────────────────────
app.post("/api/login", (req, res) => {
  const { code } = req.body;
  if (code === ACCESS_CODE) {
    const token = generateToken();
    console.log("✅ Login successful");
    return res.json({ ok: true, token });
  }
  console.log("❌ Login failed — wrong code");
  res.status(401).json({ ok: false, message: "Incorrect access code" });
});

// ── Verify token endpoint (dashboard checks this on load) ──
app.post("/api/verify", (req, res) => {
  const { token } = req.body;
  res.json({ valid: validTokens.has(token) });
});

// ── Routes ───────────────────────────────────────────────
app.get("/",          (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/dashboard", (_, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/health",    (_, res) => res.json({ status: "ok", app: "AXIOM", time: new Date() }));

// ═══════════════════════════════════════════════════════
// ── OPC-UA SESSIONS (with auto-reconnect) ───────────────
// ═══════════════════════════════════════════════════════
const clientSessions = new Map();

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`🔗 Browser connected from ${ip}`);
  let authenticated = false;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── AUTH CHECK (token must be validated before anything else) ──
    if (msg.type === "auth") {
      authenticated = validTokens.has(msg.token);
      send(ws, { type: "auth_result", ok: authenticated });
      if (!authenticated) {
        console.log("❌ WebSocket auth failed — closing");
        ws.close();
      }
      return;
    }

    if (!authenticated) {
      send(ws, { type: "error", message: "Not authenticated. Please log in again." });
      return;
    }

    // ── CONNECT to OPC-UA (with retry/reconnect logic) ──────────
    if (msg.type === "connect") {
      const { endpoint, tags, auth } = msg;
      console.log(`⟳  Connecting → ${endpoint} (${tags?.length} tags)${auth ? " [authenticated]" : ""}`);
      await cleanupClient(ws);
      await startOpcConnection(ws, endpoint, tags, auth, true);
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

// ── OPC-UA connection with auto-reconnect ──────────────────────
async function startOpcConnection(ws, endpoint, tags, auth, allowRetry) {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    connectionStrategy: {
      maxRetry: allowRetry ? -1 : 0,    // -1 = retry forever
      initialDelay: 1000,
      maxDelay: 10000,
    },
  });

  // Auto-reconnect event hooks
  client.on("backoff", (retryCount, delay) => {
    console.log(`🔁 OPC-UA reconnect attempt #${retryCount} in ${delay}ms`);
    send(ws, { type: "reconnecting", attempt: retryCount });
  });
  client.on("connection_lost", () => {
    console.log("⚠️  OPC-UA connection lost — attempting auto-reconnect");
    send(ws, { type: "connection_lost" });
  });
  client.on("connection_reestablished", () => {
    console.log("✅ OPC-UA connection restored");
    send(ws, { type: "connection_restored" });
  });

  try {
    await client.connect(endpoint);
    const session = await client.createSession(
      auth && auth.user ? { userName: auth.user, password: auth.pass } : {}
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
        // Read failed but connection might still be alive (auto-reconnect handles it)
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
  console.log("║   AXIOM Industrial AI Monitor — v2 (Secure)  ║");
  console.log(`║   Running on port ${PORT}                       ║`);
  console.log(`║   Access code: ${ACCESS_CODE.padEnd(30)}║`);
  console.log("║   /          → Login + Landing page          ║");
  console.log("║   /dashboard → Live dashboard                ║");
  console.log("║   /health    → Health check                  ║");
  console.log("╚══════════════════════════════════════════════╝\n");
});
