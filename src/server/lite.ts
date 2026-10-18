/**
 * WA-AKG Lite — Stripped-down server for POS bill sending only.
 * Removes: Socket.io, Sticker maker, Scheduler, Swagger, System monitor, Chat UI
 * Keeps: Login, Sessions, QR, Send message, API key auth, Health, Ping
 *
 * Memory usage: ~150MB (vs 500MB+ for full WA-AKG)
 * Fits on Render Free tier (512MB limit)
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { waManager } from "../modules/whatsapp/manager";
import { logger } from "../lib/logger";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

if (!process.env.AUTH_SECRET) {
  logger.error("Server", "AUTH_SECRET is not set. Generate one with: openssl rand -base64 32");
  process.exit(1);
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      if (!req.url) return;
      const parsedUrl = parse(req.url, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      logger.error("Server", "Error handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  // NO Socket.io — removed to save memory
  // NO scheduler — removed to save memory

  // Initialize WhatsApp Manager (without Socket.io — use mock)
  const { MockServer } = require("../lib/mock-socket");
  const mockIo = new MockServer();
  (global as any).io = mockIo;

  try {
    waManager.setup(mockIo as any);
    // Auto-load existing sessions after 2 seconds
    setTimeout(async () => {
      try {
        await waManager.loadSessions();
        logger.success("Server", "WhatsApp manager loaded sessions");
      } catch (e) {
        logger.error("Server", "Failed to load sessions:", e);
      }
    }, 2000);
  } catch (e) {
    logger.error("Server", "WhatsApp manager setup failed:", e);
  }

  server.listen(port, hostname, () => {
    console.log("┌──────────────────────────────────────────┐");
    console.log("│                                          │");
    console.log("│   ⚡ WA-AKG Lite  v2.0.0                 │");
    console.log("│                                          │");
    console.log(`│   ● Server  http://${hostname}:${port}                │`);
    console.log(`│   ● Node    ${process.version}                │`);
    console.log(`│   ● Env     ${process.env.NODE_ENV || "development"}             │`);
    console.log("│                                          │");
    console.log("└──────────────────────────────────────────┘");
  });
});
