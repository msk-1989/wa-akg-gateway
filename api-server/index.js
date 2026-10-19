// Pure Express API server for multinex POS WhatsApp bill sending
// No Next.js, no React — just API + simple QR page
// Memory: ~120MB (fits Render Free 512MB)
// Auth state stored in DB (Neon) — survives Render restarts

import express from "express";
import { PrismaClient } from "@prisma/client";
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import P from "pino";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();
const logger = P({ level: "error" });
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ===== Database-backed Auth State (survives Render restarts) =====
// Custom auth state that stores credentials in PostgreSQL (Neon)
// instead of filesystem (which is ephemeral on Render free tier)

import { BufferJSON } from "@whiskeysockets/baileys";

// We'll use a simple key-value table in the DB for auth state
// Create it on first use
async function ensureAuthStateTable() {
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AuthState" (
        "sessionId" TEXT NOT NULL,
        "key" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        PRIMARY KEY ("sessionId", "key")
      )
    `);
  } catch (e) {
    console.error("[Auth] Failed to create AuthState table:", e.message);
  }
}

async function getDBAuthState(sessionId) {
  await ensureAuthStateTable();

  // Try to load existing creds
  let creds = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT value FROM "AuthState" WHERE "sessionId" = $1 AND key = 'creds'`,
      sessionId
    );
    if (rows && rows.length > 0) {
      creds = JSON.parse(rows[0].value, BufferJSON.reviver);
    }
  } catch {}

  if (!creds) {
    // Generate new creds
    const { initAuthCreds } = await import("@whiskeysockets/baileys");
    creds = initAuthCreds();
  }

  const saveCreds = async () => {
    try {
      const serialized = JSON.stringify(creds, BufferJSON.replacer);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "AuthState" ("sessionId", "key", "value") VALUES ($1, 'creds', $2)
         ON CONFLICT ("sessionId", "key") DO UPDATE SET "value" = $2`,
        sessionId, serialized
      );
    } catch (e) {
      console.error("[Auth] Failed to save creds:", e.message);
    }
  };

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          try {
            const rows = await prisma.$queryRawUnsafe(
              `SELECT value FROM "AuthState" WHERE "sessionId" = $1 AND key = $2`,
              sessionId, `${type}-${id}`
            );
            if (rows && rows.length > 0) {
              let value = JSON.parse(rows[0].value, BufferJSON.reviver);
              if (type === "app-state-sync-key" && value) {
                value = value?.data ? value : { data: value, level: 1 };
              }
              data[id] = value;
            }
          } catch {}
        }
        return data;
      },
      set: async (data) => {
        for (const category in data || {}) {
          for (const id in data[category]) {
            const value = data[category][id];
            const key = `${category}-${id}`;
            try {
              if (value) {
                const serialized = JSON.stringify(value, BufferJSON.replacer);
                await prisma.$executeRawUnsafe(
                  `INSERT INTO "AuthState" ("sessionId", "key", "value") VALUES ($1, $2, $3)
                   ON CONFLICT ("sessionId", "key") DO UPDATE SET "value" = $3`,
                  sessionId, key, serialized
                );
              } else {
                await prisma.$executeRawUnsafe(
                  `DELETE FROM "AuthState" WHERE "sessionId" = $1 AND key = $2`,
                  sessionId, key
                );
              }
            } catch {}
          }
        }
      },
    },
  };

  return { state, saveCreds };
}

async function clearDBAuthState(sessionId) {
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "AuthState" WHERE "sessionId" = $1`,
      sessionId
    );
  } catch (e) {
    console.error("[Auth] Failed to clear auth state:", e.message);
  }
}

// ===== WhatsApp Session Manager =====
const sessions = new Map(); // sessionId -> { socket, status, qr, phone }

async function startSession(sessionId) {
  if (sessions.has(sessionId) && sessions.get(sessionId).socket) return;

  const { state, saveCreds } = await getDBAuthState(sessionId);
  const { version } = await fetchLatestBaileysVersion();

  const runtime = { socket: null, status: "CONNECTING", qr: null, phone: null };
  sessions.set(sessionId, runtime);

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: ["multinex-pos", "Chrome", "1.0.0"],
  });
  runtime.socket = sock;

  sock.ev.on("creds.update", saveCreds);
  
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      runtime.status = "QR";
      runtime.qr = qr;
      try {
        await prisma.session.update({
          where: { sessionId },
          data: { status: "QR", qr },
        });
      } catch {}
    }
    
    if (connection === "open") {
      runtime.status = "CONNECTED";
      runtime.qr = null;
      runtime.phone = sock.user?.id?.split(":")[0] || null;
      try {
        await prisma.session.update({
          where: { sessionId },
          data: { status: "CONNECTED", qr: null, phone: runtime.phone },
        });
      } catch {}
      console.log(`[WA] Session ${sessionId} connected`);
    }
    
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      runtime.status = shouldReconnect ? "DISCONNECTED" : "STOPPED";
      
      try {
        await prisma.session.update({
          where: { sessionId },
          data: { status: runtime.status },
        });
      } catch {}
      
      if (shouldReconnect) {
        setTimeout(() => startSession(sessionId), 2000);
      } else {
        // Logged out — clear auth
        await clearDBAuthState(sessionId);
        sessions.delete(sessionId);
      }
    }
  });
  
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      if (!m.key.fromMe && m.key.remoteJid) {
        const text = m.message?.conversation || m.message?.extendedTextMessage?.text || "";
        try {
          await prisma.message.create({
            data: {
              sessionId,
              remoteJid: m.key.remoteJid,
              fromMe: false,
              keyId: m.key.id,
              content: text,
              status: "RECEIVED",
            },
          });
        } catch {}
      }
    }
  });
}

// ===== API Key Auth Middleware =====
async function requireAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (apiKey) {
    const user = await prisma.user.findFirst({ where: { apiKey } });
    if (user) { req.user = user; return next(); }
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// ===== Routes =====

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// Ping (keep awake)
app.get("/api/ping", async (req, res) => {
  let connected = 0;
  try {
    const sess = await prisma.session.findMany();
    connected = sess.filter(s => s.status === "CONNECTED").length;
  } catch {}
  res.json({ status: "ok", sessions: connected, message: "pong" });
});

// List sessions
app.get("/api/sessions", requireAuth, async (req, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user.id },
    select: { id: true, sessionId: true, name: true, status: true, phone: true, createdAt: true },
  });
  res.json({ status: true, data: sessions });
});

// Create session
app.post("/api/sessions", requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  
  const sessionId = crypto.randomBytes(4).toString("hex");
  const session = await prisma.session.create({
    data: { userId: req.user.id, name, sessionId, status: "STOPPED" },
  });
  
  res.json({ status: true, data: session });
});

// Get QR code
app.get("/api/sessions/:sessionId/qr", requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const session = await prisma.session.findUnique({ where: { sessionId } });
  if (!session) return res.status(404).json({ error: "Session not found" });
  
  if (session.status === "CONNECTED") {
    return res.json({ connected: true, qr: null });
  }
  
  // Start session if not running
  if (!sessions.has(sessionId)) {
    await startSession(sessionId);
  }
  
  // Wait for QR (up to 15s)
  let qr = session.qr;
  if (!qr) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      const fresh = await prisma.session.findUnique({ where: { sessionId } });
      if (fresh?.status === "CONNECTED") return res.json({ connected: true, qr: null });
      if (fresh?.qr) { qr = fresh.qr; break; }
    }
  }
  
  if (!qr) return res.status(202).json({ error: "QR not ready, retry" });
  
  const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 400 });
  res.json({ connected: false, qr: dataUrl });
});

// Start/Stop session
app.patch("/api/sessions/:sessionId", requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const { action } = req.body;
  
  if (action === "start" || action === "restart") {
    // Force clean restart: stop socket, clear auth state, start fresh
    const rt = sessions.get(sessionId);
    if (rt?.socket) {
      try { await rt.socket.end(new Error("restart")); } catch {}
    }
    sessions.delete(sessionId);
    
    // Clear auth state directory for fresh QR
    
    if (true) {
      await clearDBAuthState(sessionId);
    }
    
    await prisma.session.update({ where: { sessionId }, data: { status: "STOPPED", qr: null } });
    
    // Start fresh
    await startSession(sessionId);
    return res.json({ status: true, message: "Session restarted with fresh QR" });
  }
  
  if (action === "stop") {
    const rt = sessions.get(sessionId);
    if (rt?.socket) {
      try { await rt.socket.end(new Error("manual stop")); } catch {}
    }
    sessions.delete(sessionId);
    await prisma.session.update({ where: { sessionId }, data: { status: "STOPPED" } });
    return res.json({ status: true });
  }
  
  if (action === "delete") {
    // Full delete: stop socket, clear auth, delete from DB
    const rt = sessions.get(sessionId);
    if (rt?.socket) {
      try { await rt.socket.logout(); } catch {}
      try { await rt.socket.end(new Error("delete")); } catch {}
    }
    sessions.delete(sessionId);
    
    // Clear auth state
    
    if (true) {
      await clearDBAuthState(sessionId);
    }
    
    // Delete from DB
    try { await prisma.message.deleteMany({ where: { sessionId } }); } catch {}
    try { await prisma.session.delete({ where: { sessionId } }); } catch {}
    
    return res.json({ status: true, message: "Session deleted" });
  }
  
  res.status(400).json({ error: "Unknown action" });
});

// Delete session
app.delete("/api/sessions/:sessionId", requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  const rt = sessions.get(sessionId);
  if (rt?.socket) {
    try { await rt.socket.logout(); } catch {}
    try { await rt.socket.end(new Error("delete")); } catch {}
  }
  sessions.delete(sessionId);
  
  
  if (true) {
    await clearDBAuthState(sessionId);
  }
  
  try { await prisma.message.deleteMany({ where: { sessionId } }); } catch {}
  try { await prisma.session.delete({ where: { sessionId } }); } catch {}
  
  res.json({ status: true, message: "Session deleted" });
});

// Send message (THE KEY ENDPOINT for POS bills)
app.post("/api/messages/:sessionId/:jid/send", requireAuth, async (req, res) => {
  const { sessionId, jid } = req.params;
  const { message } = req.body;
  
  if (!message) return res.status(400).json({ error: "message required" });
  
  const rt = sessions.get(sessionId);
  if (!rt?.socket) return res.status(503).json({ error: "Session not connected" });
  
  try {
    const targetJid = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
    let sent;
    
    if (message.text) {
      sent = await rt.socket.sendMessage(targetJid, { text: message.text });
    } else if (message.document) {
      sent = await rt.socket.sendMessage(targetJid, {
        document: { url: message.document.url },
        fileName: message.document.fileName || "document.pdf",
        caption: message.caption || "",
      });
    } else if (message.image) {
      sent = await rt.socket.sendMessage(targetJid, {
        image: { url: message.image.url },
        caption: message.caption || "",
      });
    } else {
      return res.status(400).json({ error: "No supported message type" });
    }
    
    // Save to DB
    try {
      await prisma.message.create({
        data: {
          sessionId,
          remoteJid: targetJid,
          fromMe: true,
          keyId: sent?.key?.id || "",
          content: message.text || message.caption || "",
          status: "SENT",
        },
      });
    } catch {}
    
    res.json({ status: true, message: "Message sent", data: { key: sent?.key } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate API key
app.post("/api/user/api-key", requireAuth, async (req, res) => {
  const apiKey = "wag_" + crypto.randomBytes(16).toString("hex");
  await prisma.user.update({ where: { id: req.user.id }, data: { apiKey } });
  res.json({ status: true, apiKey });
});

// Get API key
app.get("/api/user/api-key", requireAuth, async (req, res) => {
  res.json({ status: true, apiKey: req.user.apiKey });
});

// ===== Simple QR Scan Page (HTML, no React) =====
app.get("/", async (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>multinex WA Gateway</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.card { background: #1a1a1a; padding: 40px; border-radius: 16px; width: 100%; max-width: 380px; text-align: center; }
h1 { font-size: 22px; margin-bottom: 8px; }
h2 { font-size: 16px; color: #888; margin-bottom: 24px; font-weight: normal; }
input { width: 100%; padding: 14px; margin: 8px 0; background: #0a0a0a; border: 1px solid #333; border-radius: 10px; color: #fff; font-size: 15px; }
button { width: 100%; padding: 14px; background: #25D366; border: none; border-radius: 10px; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 12px; }
button:active { transform: scale(0.98); }
#qr img { width: 280px; height: 280px; border-radius: 12px; background: #fff; padding: 8px; margin: 16px 0; }
.status { font-size: 14px; color: #888; margin-top: 12px; }
.connected { color: #25D366; font-size: 20px; font-weight: 600; }
.spinner { width: 40px; height: 40px; border: 4px solid #333; border-top: 4px solid #25D366; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
@keyframes spin { 100% { transform: rotate(360deg); } }
.hidden { display: none; }
.logout { background: transparent; border: 1px solid #333; color: #666; font-size: 13px; padding: 8px; margin-top: 20px; }
</style>
</head><body>
<div class="card">
<h1>multinex WA Gateway</h1>

<div id="loginScreen">
<h2>Sign in to connect WhatsApp</h2>
<input type="email" id="email" placeholder="Email" value="admin@multinex.in">
<input type="password" id="password" placeholder="Password">
<button onclick="doLogin()">Sign In</button>
</div>

<div id="qrScreen" class="hidden">
<h2>Scan with WhatsApp</h2>
<p style="font-size:13px;color:#666;margin-bottom:16px">WhatsApp → Settings → Linked Devices → Link a Device</p>
<div id="qr"></div>
<div id="status" class="status">Generating QR...</div>
<button class="logout" onclick="resetConnection()" style="background:#ef4444;border:none;color:#fff;font-weight:600">Reset Connection (Fresh QR)</button>
<button class="logout" onclick="doLogout()">Logout</button>
</div>

<div id="connectedScreen" class="hidden">
<div style="font-size:48px;margin-bottom:16px">✅</div>
<h1 style="color:#25D366">Connected!</h1>
<p class="status" id="phoneDisplay"></p>
<p class="status" style="margin-top:16px">Your gateway is ready for POS bill sending.</p>
<button class="logout" onclick="doLogout()">Logout</button>
</div>

</div>
<script>
let token = localStorage.getItem('wa_token') || '';
let sessionId = '';
let polling = false;

async function doLogin() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (data.apiKey) {
    token = data.apiKey;
    localStorage.setItem('wa_token', token);
    init();
  } else {
    alert(data.error || 'Login failed');
  }
}

async function init() {
  document.getElementById('loginScreen').classList.add('hidden');
  
  // Get or create session
  let res = await fetch('/api/sessions', { headers: { 'X-API-Key': token } });
  let data = await res.json();
  
  if (!data.data || data.data.length === 0) {
    // Auto-create session
    res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'X-API-Key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pos' })
    });
    data = await res.json();
    sessionId = data.data.sessionId;
  } else {
    sessionId = data.data[0].sessionId;
  }
  
  // Check if already connected
  if (data.data && data.data[0] && data.data[0].status === 'CONNECTED') {
    showConnected(data.data[0].phone);
    return;
  }
  
  // Show QR screen and start auto-polling
  document.getElementById('qrScreen').classList.remove('hidden');
  startPolling();
}

async function startPolling() {
  if (polling) return;
  polling = true;
  
  while (polling) {
    try {
      const res = await fetch('/api/sessions/' + sessionId + '/qr', { headers: { 'X-API-Key': token } });
      const data = await res.json();
      
      if (data.connected) {
        polling = false;
        const sRes = await fetch('/api/sessions', { headers: { 'X-API-Key': token } });
        const sData = await sRes.json();
        const phone = sData.data?.[0]?.phone || '';
        showConnected(phone);
        return;
      }
      
      if (data.qr) {
        document.getElementById('qr').innerHTML = '<img src="' + data.qr + '">';
        document.getElementById('status').textContent = 'Scan the QR code above';
      } else {
        document.getElementById('qr').innerHTML = '<div class="spinner"></div>';
        document.getElementById('status').textContent = 'Generating fresh QR...';
      }
    } catch (e) {}
    
    await new Promise(r => setTimeout(r, 3000));
  }
}

function showConnected(phone) {
  document.getElementById('qrScreen').classList.add('hidden');
  document.getElementById('connectedScreen').classList.remove('hidden');
  if (phone) document.getElementById('phoneDisplay').textContent = 'Connected: +' + phone;
}

function doLogout() {
  localStorage.removeItem('wa_token');
  token = '';
  polling = false;
  location.reload();
}

async function resetConnection() {
  if (!confirm('This will delete the current session and create a fresh one. Continue?')) return;
  document.getElementById('status').textContent = 'Resetting...';
  
  // Delete current session completely
  await fetch('/api/sessions/' + sessionId, {
    method: 'DELETE',
    headers: { 'X-API-Key': token }
  });
  
  // Create new fresh session
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'X-API-Key': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'pos' })
  });
  const data = await res.json();
  if (data.data) {
    sessionId = data.data.sessionId;
    document.getElementById('status').textContent = 'Fresh QR generating...';
    // Polling continues automatically
  }
}

if (token) init();
</script>
</body></html>`);
});

// Login endpoint (returns API key)
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email: email?.toLowerCase() } });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });
  
  // Generate API key if not exists
  let apiKey = user.apiKey;
  if (!apiKey) {
    apiKey = "wag_" + crypto.randomBytes(16).toString("hex");
    await prisma.user.update({ where: { id: user.id }, data: { apiKey } });
  }
  
  res.json({ apiKey, role: user.role });
});

// ===== Start Server =====
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`⚡ multinex WA API on port ${PORT}`);
  
  // Create admin user if not exists
  const adminEmail = process.env.ADMIN_EMAIL || "admin@multinex.in";
  const adminPass = process.env.ADMIN_PASSWORD || "admin123";
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existing) {
    const hash = await bcrypt.hash(adminPass, 10);
    await prisma.user.create({
      data: { email: adminEmail, name: "Admin", password: hash, role: "SUPERADMIN" },
    });
    console.log(`[Auth] Admin user created: ${adminEmail}`);
  }
  
  // Auto-load existing sessions
  const dbSessions = await prisma.session.findMany();
  for (const s of dbSessions) {
    if (s.status === "CONNECTED" || s.status === "DISCONNECTED") {
      startSession(s.sessionId).catch(e => console.error("[WA] Failed to start", s.sessionId, e));
    }
  }
  console.log(`[WA] Loaded ${dbSessions.length} sessions`);
});
