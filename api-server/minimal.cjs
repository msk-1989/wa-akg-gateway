// ABSOLUTE MINIMUM WhatsApp Gateway with DB-backed auth state
// Survives Render restarts — auth state stored in Neon PostgreSQL
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, BufferJSON } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const P = require("pino");
const { Client: PgClient } = require("pg");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.WA_API_KEY || "wag_715161238df6a2c9f969b3f39836060c";
const DB_URL = process.env.DATABASE_URL;

// ===== PostgreSQL connection for auth state =====
let pgClient = null;
async function getDb() {
  if (!pgClient && DB_URL) {
    pgClient = new PgClient({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
    await pgClient.query(`CREATE TABLE IF NOT EXISTS "wa_auth" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`);
    console.log("[DB] Connected for auth state");
  }
  return pgClient;
}

// ===== DB-backed Auth State =====
async function getDBAuthState() {
  const db = await getDb();
  let creds = null;
  try {
    const res = await db.query(`SELECT value FROM wa_auth WHERE key = 'creds'`);
    if (res.rows.length > 0) creds = JSON.parse(res.rows[0].value, BufferJSON.reviver);
  } catch {}
  if (!creds) {
    const { initAuthCreds } = require("@whiskeysockets/baileys");
    creds = initAuthCreds();
  }
  const saveCreds = async () => {
    try {
      const s = JSON.stringify(creds, BufferJSON.replacer);
      await db.query(`INSERT INTO wa_auth (key, value) VALUES ('creds', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [s]);
    } catch (e) { console.error("[Auth] save error:", e.message); }
  };
  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data = {};
        for (const id of ids) {
          try {
            const res = await db.query(`SELECT value FROM wa_auth WHERE key = $1`, [`${type}-${id}`]);
            if (res.rows.length > 0) {
              let v = JSON.parse(res.rows[0].value, BufferJSON.reviver);
              if (type === "app-state-sync-key" && v) v = v?.data ? v : { data: v, level: 1 };
              data[id] = v;
            }
          } catch {}
        }
        return data;
      },
      set: async (dataObj) => {
        for (const cat in dataObj || {}) {
          for (const id in dataObj[cat]) {
            const v = dataObj[cat][id];
            const k = `${cat}-${id}`;
            try {
              if (v) {
                const s = JSON.stringify(v, BufferJSON.replacer);
                await db.query(`INSERT INTO wa_auth (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [k, s]);
              } else {
                await db.query(`DELETE FROM wa_auth WHERE key = $1`, [k]);
              }
            } catch {}
          }
        }
      },
    },
  };
  return { state, saveCreds };
}

async function clearAuth() {
  try { const db = await getDb(); await db.query(`DELETE FROM wa_auth`); } catch {}
}

// ===== Session state =====
let waSocket = null, waStatus = "DISCONNECTED", waQR = null, waPhone = null;

async function connectWhatsApp() {
  const { state, saveCreds } = await getDBAuthState();
  const { version } = await fetchLatestBaileysVersion();
  waStatus = "CONNECTING";
  const sock = makeWASocket({ version, logger: P({ level: "silent" }), auth: state, printQRInTerminal: false, markOnlineOnConnect: false, browser: ["multinex-pos", "Chrome", "1.0.0"] });
  waSocket = sock;
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) { waStatus = "QR"; waQR = qr; console.log("[WA] QR generated"); }
    if (connection === "open") { waStatus = "CONNECTED"; waQR = null; waPhone = sock.user?.id?.split(":")[0] || null; console.log("[WA] Connected:", waPhone); }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      waStatus = reconnect ? "DISCONNECTED" : "STOPPED"; waQR = null;
      if (reconnect) setTimeout(() => connectWhatsApp(), 3000);
      else { clearAuth().then(() => setTimeout(() => connectWhatsApp(), 3000)); }
    }
  });
}
connectWhatsApp();

// ===== HTTP Server =====
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (url.pathname === "/api/health") { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({status:"ok",uptime:process.uptime(),whatsapp:waStatus})); return; }
  if (url.pathname === "/api/ping") { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({status:"ok",whatsapp:waStatus,message:"pong"})); return; }

  const authed = req.headers["x-api-key"] === API_KEY;

  if (url.pathname === "/api/qr" && req.method === "GET") {
    if (!authed) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    if (waStatus === "CONNECTED") { res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({connected:true,qr:null,phone:waPhone})); return; }
    if (waQR) { const d = await QRCode.toDataURL(waQR, {margin:1,width:400}); res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({connected:false,qr:d,status:waStatus})); return; }
    res.writeHead(202, {"Content-Type":"application/json"}); res.end(JSON.stringify({connected:false,qr:null,status:waStatus})); return;
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    if (!authed) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({status:waStatus,phone:waPhone,apiKey:API_KEY})); return;
  }

  if (url.pathname.startsWith("/api/send/") && req.method === "POST") {
    if (!authed) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    let body = ""; req.on("data", c => body += c); req.on("end", async () => {
      try {
        if (waStatus !== "CONNECTED") { for (let i=0;i<30;i++) { if (waStatus==="CONNECTED"&&waSocket) break; await new Promise(r=>setTimeout(r,500)); } }
        if (!waSocket || waStatus !== "CONNECTED") { res.writeHead(503, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"WhatsApp not connected",status:waStatus})); return; }
        const { message, phone } = JSON.parse(body);
        const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
        let sent;
        if (message.text) sent = await waSocket.sendMessage(jid, {text: message.text});
        else if (message.document) sent = await waSocket.sendMessage(jid, {document:{url:message.document.url},fileName:message.document.fileName||"file.pdf",caption:message.caption||""});
        else if (message.image) sent = await waSocket.sendMessage(jid, {image:{url:message.image.url},caption:message.caption||""});
        else { res.writeHead(400, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:"No supported message type"})); return; }
        res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({status:true,messageId:sent?.key?.id}));
      } catch (e) { res.writeHead(500, {"Content-Type":"application/json"}); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  if (url.pathname === "/api/reset" && req.method === "POST") {
    if (!authed) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    try { if (waSocket) { try{await waSocket.logout()}catch{} } await clearAuth(); } catch {}
    waSocket = null; waStatus = "DISCONNECTED"; waQR = null;
    setTimeout(() => connectWhatsApp(), 1000);
    res.writeHead(200, {"Content-Type":"application/json"}); res.end(JSON.stringify({status:true,message:"Resetting"})); return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, {"Content-Type":"text/html"});
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>multinex WA</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.c{background:#1a1a1a;padding:40px;border-radius:16px;width:100%;max-width:380px;text-align:center}h1{font-size:22px;margin-bottom:8px}h2{font-size:15px;color:#888;margin-bottom:20px;font-weight:400}input{width:100%;padding:14px;margin:6px 0;background:#0a0a0a;border:1px solid #333;border-radius:10px;color:#fff;font-size:15px}button{width:100%;padding:14px;background:#25D366;border:none;border-radius:10px;color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-top:10px}button:active{transform:scale(.98)}img{width:280px;height:280px;border-radius:12px;background:#fff;padding:8px;margin:16px 0}.s{font-size:14px;color:#888;margin-top:10px}.ok{color:#25D366;font-size:48px;margin:16px 0}.r{background:#ef4444;margin-top:8px}.h{display:none}</style></head><body>
<div class="c"><h1>multinex WA Gateway</h1>
<div id="login"><h2>Enter API key</h2><input id="key" placeholder="wag_..." type="password" value="${API_KEY}"><button onclick="login()">Connect</button></div>
<div id="qr" class="h"><h2>Scan with WhatsApp</h2><p class="s">Settings → Linked Devices → Link a Device</p><div id="qrimg"></div><div id="status" class="s">Loading...</div><button class="r" onclick="reset()">Reset (Fresh QR)</button></div>
<div id="done" class="h"><div class="ok">✅</div><h1>Connected!</h1><p class="s" id="phone"></p><p class="s">Gateway ready for POS bills</p></div></div>
<script>let k='${API_KEY}';async function login(){document.getElementById('login').classList.add('h');document.getElementById('qr').classList.remove('h');poll()}async function poll(){try{const r=await fetch('/api/qr',{headers:{'X-API-Key':k}});const d=await r.json();if(d.connected){document.getElementById('qr').classList.add('h');document.getElementById('done').classList.remove('h');if(d.phone)document.getElementById('phone').textContent='+'+d.phone;return}if(d.qr){document.getElementById('qrimg').innerHTML='<img src="'+d.qr+'">';document.getElementById('status').textContent='Scan the QR code'}else{document.getElementById('qrimg').innerHTML='';document.getElementById('status').textContent='Generating QR...'}}catch(e){}setTimeout(poll,3000)}async function reset(){await fetch('/api/reset',{method:'POST',headers:{'X-API-Key':k}});document.getElementById('status').textContent='Resetting...'}</script>
</body></html>`);
    return;
  }
  res.writeHead(404); res.end("Not found");
}).listen(PORT, "0.0.0.0", () => { console.log(`⚡ multinex WA API on port ${PORT}`); console.log(`📋 API Key: ${API_KEY}`); });
