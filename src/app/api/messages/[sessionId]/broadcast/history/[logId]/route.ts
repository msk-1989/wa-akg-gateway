import { prisma } from "@/lib/prisma";
import { NextResponse, NextRequest } from "next/server";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; logId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized" }, { status: 401 });
        }

        const { sessionId, logId } = await params;

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden" }, { status: 403 });
        }

        const log = await prisma.broadcastLog.findFirst({
            where: { id: logId, sessionId },
            include: { recipients: true }
        });

        if (!log) {
            return NextResponse.json({ status: false, message: "Broadcast not found" }, { status: 404 });
        }

        return NextResponse.json({ status: true, data: log });
    } catch (e) {
        console.error("Broadcast detail error:", e);
        return NextResponse.json({ status: false, message: "Failed to fetch detail" }, { status: 500 });
    }
}
