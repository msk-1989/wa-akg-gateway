# 🚀 WA-AKG on Render Free Tier + UptimeRobot

**Total cost: ₹0/month** (Render Free + Neon Free + UptimeRobot Free)

## How It Works

```
UptimeRobot (free)          Render (free)           Neon (free)
     │                           │                      │
     │  ping every 5 min         │                      │
     ├──────────────────────────►│                      │
     │                           │  queries             │
     │                           ├─────────────────────►│
     │                           │  WhatsApp WebSocket  │
     │                           ├─────────────────────►│ WhatsApp servers
     │                           │  (stays alive)       │
     ▼                           ▼                      ▼
  keeps awake              sends bills             stores data
```

---

## Step 1: Push Code to GitHub

### Option A: Fork the original + add my files
1. Fork https://github.com/mrifqidaffaaditya/WA-AKG
2. Add these files from this sandbox to your fork:
   - `Dockerfile.prod` (replaces MySQL with PostgreSQL)
   - `prisma/schema.postgres.prisma` (PostgreSQL schema)
   - `next.config.ts` (with `ignoreBuildErrors` + `serverActions.allowedOrigins`)
   - `src/app/api/health/route.ts` (health check)
   - `src/app/api/ping/route.ts` (keep-awake endpoint)
   - `render.yaml` (Render blueprint — free plan)
   - `.env.production.example` (env var reference)
3. Commit → push to your GitHub

### Option B: Download all code from sandbox
Use the sandbox file browser to download all files, push to a new GitHub repo.

---

## Step 2: Get Neon Database (free)

1. Go to [neon.tech](https://neon.tech) → sign up
2. Create a new project → name it `wa-akg`
3. Copy **two** connection strings from the dashboard:
   - **Pooled**: `postgresql://user:pass@ep-xxx-pooler.neon.tech/db?sslmode=require`
   - **Direct**: `postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require`
4. Save both — you'll need them in Step 3

> If Neon only gives you one URL, use it for both `DATABASE_URL` and `DIRECT_URL`.

---

## Step 3: Deploy on Render (free)

1. Go to [render.com](https://render.com) → sign up
2. **New +** → **Web Service**
3. Connect your GitHub account → select your `wa-akg` repo
4. Render auto-detects `render.yaml` — review settings:
   - **Name**: `wa-akg-gateway`
   - **Runtime**: Docker
   - **Dockerfile Path**: `./Dockerfile.prod`
   - **Plan**: **Free** ← important!
5. Set environment variables (Render → Environment tab):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon pooled URL (from Step 2) |
| `DIRECT_URL` | Neon direct URL (from Step 2) |
| `AUTH_SECRET` | Run in terminal: `openssl rand -base64 32` |
| `NEXTAUTH_URL` | `https://wa-akg-gateway.onrender.com` (your Render URL) |
| `ADMIN_EMAIL` | `admin@multinex.in` |
| `ADMIN_PASSWORD` | A strong password |
| `TZ` | `Asia/Kolkata` |

> The other variables (`NODE_ENV`, `PORT`, `LOCALE`, etc.) are pre-filled from `render.yaml`.

6. Click **Create Web Service**
7. Wait 3-5 minutes for build to complete
8. Watch the logs — when you see `⚡ WA-AKG v1.6.4` and `● Server http://0.0.0.0:3000`, it's live!

---

## Step 4: Update NEXTAUTH_URL (after first deploy)

1. Copy your Render URL: `https://wa-akg-gateway.onrender.com`
2. Render → your service → **Environment** tab
3. Update `NEXTAUTH_URL` to your exact Render URL
4. Save → Render auto-redeploys

---

## Step 5: Set Up UptimeRobot (free) — CRITICAL

This keeps your Render service awake so WhatsApp stays connected.

1. Go to [uptimerobot.com](https://uptimerobot.com) → sign up (free)
2. **Add New Monitor**
3. Settings:
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: `WA-AKG Gateway`
   - **URL**: `https://wa-akg-gateway.onrender.com/api/ping`
   - **Monitoring Interval**: `5 minutes`
4. **Save**

> The `/api/ping` endpoint returns JSON with WhatsApp session status:
> ```json
> {
>   "status": "ok",
>   "whatsapp": { "totalSessions": 1, "status": "1/1 connected" },
>   "message": "pong — keeping Render awake"
> }
> ```

UptimeRobot pings this every 5 minutes → Render never sleeps → WhatsApp stays connected 24/7.

---

## Step 6: Pair WhatsApp

1. Open `https://wa-akg-gateway.onrender.com/auth/login`
2. Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`
3. Go to **Sessions / QR** → **Create New Session**
4. Name it `pos` → **Create Session**
5. Click **Manage** → **Start**
6. QR code appears → scan with WhatsApp → Linked devices → Link a device
7. Status changes to **CONNECTED**
8. Note the **Session ID** (short string like `abc123`) — you'll need it for Laravel

---

## Step 7: Generate API Key

1. Dashboard → **Settings** → **API Keys** (or Profile → API Key)
2. Generate a new key → copy it (`wag_...`)
3. Save it — you'll need it for Laravel

---

## Step 8: Update Laravel `.env` on pos.multinex.in

```env
WA_BASE_URL=https://wa-akg-gateway.onrender.com
WA_API_KEY=wag_your_key_from_render_dashboard
WA_SESSION_ID=abc123
```

Then on your hosting:
```bash
php artisan config:clear
php artisan cache:clear
```

---

## Step 9: Test

From your Laravel app or terminal:
```bash
curl -s "https://wa-akg-gateway.onrender.com/api/sessions" \
  -H "X-API-Key: wag_your_key"
# Expected: {"status":true,"data":[{"name":"pos","sessionId":"abc123","status":"CONNECTED"}]}

curl -s -X POST "https://wa-akg-gateway.onrender.com/api/messages/abc123/919876543210@s.whatsapp.net/send" \
  -H "X-API-Key: wag_your_key" \
  -H "Content-Type: application/json" \
  -d '{"message":{"text":"Test from multinex POS!"}}'
# Expected: {"status":true,"message":"Message sent successfully",...}
```

---

## ⚠️ Free Tier Limitations & Mitigations

| Limitation | Impact | Mitigation |
|---|---|---|
| **Render sleeps after 15 min** | WhatsApp disconnects | ✅ UptimeRobot pings every 5 min (never sleeps) |
| **512MB RAM** | May crash with many sessions | Keep 1-2 sessions only |
| **Render restarts occasionally** | Brief downtime (~30s) | Baileys auto-reconnects (auth in Neon DB) |
| **Slow cold start** | First request after restart ~10s | UptimeRobot keeps it warm |
| **Neon 0.5GB storage** | ~50K messages | Plenty for a small shop |

---

## Troubleshooting

### "Build failed" on Render
Check Render logs. Common causes:
- `DATABASE_URL` not set → add it in Environment
- `patch-package` fails → already handled (non-fatal in Dockerfile.prod)
- Prisma generate fails → `DIRECT_URL` missing → set it = `DATABASE_URL`

### WhatsApp disconnects randomly
- Check UptimeRobot is running (dashboard → monitors)
- Check Render logs for errors
- Go to dashboard → Sessions → click **Restart**
- Baileys auth is in Neon, so it reconnects without re-scanning QR

### Login fails / redirect loop
- `NEXTAUTH_URL` is wrong → must be exact Render URL
- Run `openssl rand -base64 32` for `AUTH_SECRET`

### `/api/ping` returns 500
- DB connection issue → check `DATABASE_URL` and `DIRECT_URL`
- Neon might be suspended → check Neon dashboard

---

## Cost Summary

| Service | Plan | Cost |
|---|---|---|
| Render | Free | ₹0 |
| Neon DB | Free | ₹0 |
| UptimeRobot | Free | ₹0 |
| **Total** | | **₹0/month** |

When you outgrow free (many sessions, high volume), upgrade Render to Starter ($7/mo) — just change the plan in Render dashboard, no code changes needed.
