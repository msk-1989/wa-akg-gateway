import { prisma } from "@/lib/prisma";
import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized" }, { status: 401 });
        }

        const { sessionId } = await params;

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden" }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);
        const offset = parseInt(searchParams.get("offset") || "0");

        const [logs, total] = await Promise.all([
            prisma.broadcastLog.findMany({
                where: { sessionId },
                orderBy: { startedAt: "desc" },
                take: limit,
                skip: offset,
                include: {
                    _count: { select: { recipients: true } }
                }
            }),
            prisma.broadcastLog.count({ where: { sessionId } })
        ]);

        return NextResponse.json({
            status: true,
            data: logs,
            total,
            limit,
            offset
        });
    } catch (e) {
        console.error("Broadcast history error:", e);
        return NextResponse.json({ status: false, message: "Failed to fetch history" }, { status: 500 });
    }
}
