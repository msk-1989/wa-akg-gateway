/**
 * Self-ping endpoint — prevents Render free tier from sleeping.
 * Set up UptimeRobot (or any cron service) to hit this endpoint every 5-10 minutes.
 *
 * How it works:
 * - Render free tier sleeps after 15 min of no inbound requests
 * - When asleep, the WhatsApp connection drops (Baileys socket dies)
 * - This endpoint receives a ping → keeps the service active
 * - UptimeRobot pings it for free every 5 minutes
 *
 * Usage:
 * 1. Deploy on Render
 * 2. Go to https://uptimerobot.com (free)
 * 3. Add HTTP(s) monitor
 * 4. URL: https://your-app.onrender.com/api/ping
 * 5. Interval: 5 minutes
 *
 * The endpoint also reports WhatsApp session status so UptimeRobot
 * can alert you if the session disconnects.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let sessionStatus = "unknown";
  let connectedSessions = 0;

  try {
    const sessions = await prisma.session.findMany({
      select: { sessionId: true, name: true, status: true },
    });
    connectedSessions = sessions.filter((s) => s.status === "CONNECTED").length;
    sessionStatus = `${connectedSessions}/${sessions.length} connected`;
  } catch {
    sessionStatus = "db-error";
  }

  return NextResponse.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      whatsapp: {
        totalSessions: connectedSessions,
        status: sessionStatus,
      },
      message: "pong — keeping Render awake",
    },
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    }
  );
}
