// ABSOLUTE MINIMUM WhatsApp Gateway
// No Express, no Prisma, no database
// Just: Baileys + raw HTTP + file-based auth
// Memory: ~80MB

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const P = require("pino");

const PORT = process.env.PORT || 3000;
const AUTH_DIR = "/tmp/wa_auth";
const DATA_FILE = "/tmp/wa_data.json";

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Simple data store (JSON file in /tmp — survives most restarts on Render)
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return { apiKey: null, sessions: {} }; }
}
function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch {}
}

// Generate API key on first run
let data = loadData();
if (!data.apiKey) {
  data.apiKey = "wag_" + crypto.randomBytes(16).toString("hex");
  saveData(data);
}

// Session state
let waSocket = null;
let waStatus = "DISCONNECTED";
let waQR = null;
let waPhone = null;

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  waStatus = "CONNECTING";
  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    browser: ["multinex-pos", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000,
    qrTimeout: 40000,
  });
  waSocket = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waStatus = "QR";
      waQR = qr;
      console.log("[WA] QR generated");
    }

    if (connection === "open") {
      waStatus = "CONNECTED";
      waQR = null;
      waPhone = sock.user?.id?.split(":")[0] || null;
      console.log("[WA] Connected:", waPhone);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      waStatus = shouldReconnect ? "DISCONNECTED" : "STOPPED";
      waQR = null;
      console.log("[WA] Closed:", code, "reconnect:", shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => connectWhatsApp(), 3000);
      } else {
        // Logged out — clear auth
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        setTimeout(() => connectWhatsApp(), 3000);
      }
    }
  });

  sock.ev.on("messages.upsert", () => {});
}

// Start WhatsApp immediately
connectWhatsApp();

// ===== HTTP Server (raw, no Express) =====
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // Health check
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime(), whatsapp: waStatus }));
    return;
  }

  // Ping (keep awake)
  if (url.pathname === "/api/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", whatsapp: waStatus, message: "pong" }));
    return;
  }

  // API key auth check
  const apiKey = req.headers["x-api-key"];
  const authed = apiKey === data.apiKey;

  // Get QR code
  if (url.pathname === "/api/qr" && req.method === "GET") {
    if (!authed) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    if (waStatus === "CONNECTED") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connected: true, qr: null, phone: waPhone }));
      return;
    }
    if (waQR) {
      const dataUrl = await QRCode.toDataURL(waQR, { margin: 1, width: 400 });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connected: false, qr: dataUrl, status: waStatus }));
      return;
    }
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ connected: false, qr: null, status: waStatus }));
    return;
  }

  // Get status
  if (url.pathname === "/api/status" && req.method === "GET") {
    if (!authed) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: waStatus, phone: waPhone, apiKey: data.apiKey }));
    return;
  }

  // Send message
  if (url.pathname.startsWith("/api/send/") && req.method === "POST") {
    if (!authed) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    if (!waSocket || waStatus !== "CONNECTED") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "WhatsApp not connected", status: waStatus }));
      return;
    }

    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { message, phone } = JSON.parse(body);
        const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;

        let sent;
        if (message.text) {
          sent = await waSocket.sendMessage(jid, { text: message.text });
        } else if (message.document) {
          sent = await waSocket.sendMessage(jid, {
            document: { url: message.document.url },
            fileName: message.document.fileName || "file.pdf",
            caption: message.caption || "",
          });
        } else if (message.image) {
          sent = await waSocket.sendMessage(jid, {
            image: { url: message.image.url },
            caption: message.caption || "",
          });
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No supported message type" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: true, messageId: sent?.key?.id }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Reset connection (clear auth + reconnect)
  if (url.pathname === "/api/reset" && req.method === "POST") {
    if (!authed) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    try {
      if (waSocket) { try { await waSocket.logout(); } catch {} }
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch {}
    waSocket = null;
    waStatus = "DISCONNECTED";
    waQR = null;
    setTimeout(() => connectWhatsApp(), 1000);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: true, message: "Resetting — fresh QR in 5s" }));
    return;
  }

  // Home page (QR scan UI)
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>multinex WA</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
.c{background:#1a1a1a;padding:40px;border-radius:16px;width:100%;max-width:380px;text-align:center}
h1{font-size:22px;margin-bottom:8px}
h2{font-size:15px;color:#888;margin-bottom:20px;font-weight:400}
input{width:100%;padding:14px;margin:6px 0;background:#0a0a0a;border:1px solid #333;border-radius:10px;color:#fff;font-size:15px}
button{width:100%;padding:14px;background:#25D366;border:none;border-radius:10px;color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:10px}
button:active{transform:scale(.98)}
img{width:280px;height:280px;border-radius:12px;background:#fff;padding:8px;margin:16px 0}
.s{font-size:14px;color:#888;margin-top:10px}
.ok{color:#25D366;font-size:48px;margin:16px 0}
.r{background:#ef4444;margin-top:8px}
.h{display:none}
</style></head><body>
<div class="c">
<h1>multinex WA Gateway</h1>
<div id="login"><h2>Enter API key</h2>
<input id="key" placeholder="wag_..." type="password">
<button onclick="login()">Connect</button>
<p class="s">Key: ${data.apiKey}</p>
</div>
<div id="qr" class="h"><h2>Scan with WhatsApp</h2>
<p class="s">Settings → Linked Devices → Link a Device</p>
<div id="qrimg"></div>
<div id="status" class="s">Loading...</div>
<button class="r" onclick="reset()">Reset (Fresh QR)</button></div>
<div id="done" class="h"><div class="ok">✅</div><h1>Connected!</h1>
<p class="s" id="phone"></p><p class="s">Gateway ready for POS bills</p></div>
</div>
<script>
let k=localStorage.getItem('wa_key')||'';
if(k)login();
async function login(){
  if(!k)k=document.getElementById('key').value;
  localStorage.setItem('wa_key',k);
  document.getElementById('login').classList.add('h');
  document.getElementById('qr').classList.remove('h');
  poll();
}
async function poll(){
  try{
    const r=await fetch('/api/qr',{headers:{'X-API-Key':k}});
    const d=await r.json();
    if(d.connected){
      document.getElementById('qr').classList.add('h');
      document.getElementById('done').classList.remove('h');
      if(d.phone)document.getElementById('phone').textContent='+'+d.phone;
      return;
    }
    if(d.qr){
      document.getElementById('qrimg').innerHTML='<img src="'+d.qr+'">';
      document.getElementById('status').textContent='Scan the QR code';
    }else{
      document.getElementById('qrimg').innerHTML='';
      document.getElementById('status').textContent='Generating QR...';
    }
  }catch(e){}
  setTimeout(poll,3000);
}
async function reset(){
  await fetch('/api/reset',{method:'POST',headers:{'X-API-Key':k}});
  document.getElementById('status').textContent='Resetting...';
}
</script>
</body></html>`);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ multinex WA API on port ${PORT}`);
  console.log(`📋 API Key: ${data.apiKey}`);
});
