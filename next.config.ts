import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "sharp",
    "bcryptjs",
    "@whiskeysockets/baileys",
    "jimp",
    "pino",
    "@hapi/boom",
    "socket.io",
    "socket.io-client",
    "systeminformation",
    "wa-sticker-formatter",
    "node-cron",
    "cron-parser",
  ],
  turbopack: {
    root: path.resolve(__dirname),
  },
  allowedDevOrigins: ["preview-chat-35feda42-934c-4eb6-8dda-d70a411c348a.space-z.ai"],
};

export default nextConfig;
