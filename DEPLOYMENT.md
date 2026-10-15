# 🚀 WA-AKG Production Deployment Guide

## Why Not Vercel?

**WA-AKG cannot run on Vercel.** Vercel is serverless — functions die after 10-60 seconds. WA-AKG needs:
- **Persistent WebSocket** to WhatsApp servers (Baileys) — 24/7 connection
- **Socket.io server** for real-time dashboard push
- **Background scheduler** for timed message sending

All of these require an **always-on process**, which Vercel doesn't support.

## What You Need

| Item | Where | Cost |
|---|---|---|
| **Neon PostgreSQL** | [neon.tech](https://neon.tech) | Free tier (0.5 GB) → $19/mo |
| **Railway account** | [railway.app](https://railway.app) | $5/mo (includes $5 credit) |
| **GitHub repo** | Push this code to a private repo | Free |

---

## Step 1: Set Up Neon Database

1. Go to [neon.tech](https://neon.tech) → Sign up
2. Create a new project → Name it `wa-akg`
3. Copy **two** connection strings:
   - **Pooled connection** (for app): `postgresql://user:pass@ep-pool...neon.tech/dbname?sslmode=require`
   - **Direct connection** (for migrations): `postgresql://user:pass@ep-cool...neon.tech/dbname?sslmode=require`
4. Save both — you'll need them in Step 3

> ⚠️ **Important**: Neon provides two URLs. The pooled URL uses PgBouncer (great for app connections). The direct URL bypasses PgBouncer (needed for Prisma migrations). Don't mix them up.

---

## Step 2: Push Code to GitHub

```bash
# From your local machine
git init
git add .
git commit -m "WA-AKG production ready"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/wa-akg.git
git push -u origin main
```

---

## Step 3: Deploy on Railway (Recommended)

### 3.1 Create Project
1. Go to [railway.app](https://railway.app) → **New Project**
2. Select **Deploy from GitHub repo** → Choose your `wa-akg` repo
3. Railway auto-detects the `railway.json` config

### 3.2 Set Environment Variables
In Railway → your service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string |
| `DIRECT_URL` | Neon **direct** connection string |
| `AUTH_SECRET` | Generate: `openssl rand -base64 32` |
| `NEXTAUTH_URL` | `https://wa-akg-gateway.up.railway.app` (your Railway URL) |
| `ADMIN_EMAIL` | `admin@multinex.in` (or your choice) |
| `ADMIN_PASSWORD` | Your secure password |
| `TZ` | `Asia/Kolkata` |
| `LOCALE` | `en-IN` |
| `MEDIA_STORAGE_PATH` | `uploads` |
| `BAILEYS_LOG_LEVEL` | `error` |
| `ENABLE_NOTIFICATIONS` | `true` |
| `ENABLE_AUTO_UPDATE_CHECK` | `false` |
| `ENABLE_RATE_LIMITING` | `true` |
| `RATE_LIMIT_PER_MINUTE` | `60` |
| `MAX_UPLOAD_SIZE_MB` | `50` |
| `SESSION_TIMEOUT_HOURS` | `24` |
| `NEXT_PUBLIC_APP_NAME` | `multinex WA Gateway` |
| `NEXT_PUBLIC_SWAGGER_ENABLED` | `true` |
| `NEXT_PUBLIC_SWAGGER_USERNAME` | `admin` |
| `NEXT_PUBLIC_SWAGGER_PASSWORD` | (change this!) |

### 3.3 Deploy
1. Click **Deploy**
2. Railway builds the Docker image, pushes schema to Neon, creates admin user, starts the server
3. Wait ~3 minutes for first deploy
4. Visit your Railway URL → you should see the WA-AKG login page
5. Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`

### 3.4 Pair WhatsApp
1. Go to **Sessions / QR** in the dashboard
2. Create a session → Click **Start** → Scan QR with your phone
3. Session persists across redeploys (auth state is in Neon DB)

---

## Alternative: Render

1. Go to [render.com](https://render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Render auto-detects `render.yaml`
4. Set the same environment variables (listed in `render.yaml`)
5. Deploy

---

## Alternative: Fly.io

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Login and launch
fly auth login
fly launch  # Uses fly.toml

# Set secrets
fly secrets set DATABASE_URL="postgresql://..." \
  DIRECT_URL="postgresql://..." \
  AUTH_SECRET="your-secret" \
  NEXTAUTH_URL="https://wa-akg-gateway.fly.dev" \
  ADMIN_EMAIL="admin@multinex.in" \
  ADMIN_PASSWORD="your-password"

# Deploy
fly deploy
```

---

## Connect multinex.in (PHP) to the Gateway

Once deployed, update your Laravel `.env`:

```env
WHATSAPP_GATEWAY_BASE_URL=https://wa-akg-gateway.up.railway.app
WHATSAPP_GATEWAY_API_KEY=wag_xxx  # Generate from dashboard → Settings → API Keys
WHATSAPP_GATEWAY_SESSION=pos      # Your session name
```

---

## Cost Summary

| Service | Monthly Cost |
|---|---|
| Neon DB (free tier) | ₹0 (0.5 GB storage) |
| Railway (hobby) | ~₹400 ($5) |
| **Total** | **~₹400/month** |

For higher volume:
- Neon: $19/mo (10 GB, unlimited compute)
- Railway: $20/mo (2 GB RAM, more CPU)

---

## Troubleshooting

### "Prisma Client not generated"
Railway build step runs `npx prisma generate` — make sure `prisma/schema.prisma` exists and is valid.

### "Database connection failed"
- Verify `DATABASE_URL` uses the **pooled** Neon URL
- Verify `DIRECT_URL` uses the **direct** Neon URL
- Both must end with `?sslmode=require`

### "WhatsApp session disconnects"
Railway restarts services on redeploy. The Baileys auth state is stored in Neon (AuthState table), so the session auto-reconnects after restart. If it doesn't:
1. Go to dashboard → Sessions → click **Restart**
2. If still stuck, click **Logout** → re-scan QR

### "Socket.io 404 errors"
These appear in the browser console when using the sandbox. On Railway/Render/Fly.io (which run the custom server), Socket.io works normally — no 404s.

### QR code not showing
1. Check Railway logs: `railway logs`
2. Look for Baileys connection errors
3. Ensure the session status is "CONNECTING" or "QR" (not "STOPPED")
4. Click **Start** on the session

---

## Persistent Storage for Media

Railway/Render/Fly.io have ephemeral filesystems. Media files (received images, documents) are lost on redeploy. For production:

1. Use **S3-compatible storage** (AWS S3, Cloudflare R2, Supabase Storage)
2. Or attach a **persistent volume** (Railway volumes, Render disks, Fly.io volumes)

For now, media is stored in `uploads/` which resets on redeploy. This is fine for POS bill sending (bills are sent by URL, not stored on the gateway).
