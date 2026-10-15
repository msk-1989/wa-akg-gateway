import { NextResponse, NextRequest } from "next/server";
import { waManager } from "@/modules/whatsapp/manager";
import { getAuthenticatedUser, canAccessSession } from "@/lib/api-auth";

// DELETE: Delete message for everyone
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; jid: string; messageId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId, jid, messageId } = await params;

        // Check if user can access this session
        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        const instance = waManager.getInstance(sessionId);
        if (!instance?.socket) {
            return NextResponse.json({ status: false, message: "Session not ready", error: "Session not ready" }, { status: 503 });
        }

        const decodedJid = decodeURIComponent(jid);

        // Delete message for everyone
        await instance.socket.sendMessage(decodedJid, { delete: {
            remoteJid: decodedJid,
            fromMe: true,
            id: messageId,
            participant: undefined
        }});

        return NextResponse.json({ status: true, message: "Message deleted for everyone" });

    } catch (error: any) {
        console.error("Delete message error:", error);
        
        if (error.message?.includes("too old") || error.message?.includes("time limit")) {
            return NextResponse.json({ status: false, message: "Cannot delete message older than 7 minutes", error: "Cannot delete message older than 7 minutes" }, { status: 400 });
        }
        
        return NextResponse.json({ status: false, message: "Failed to delete message", error: "Failed to delete message" }, { status: 500 });
    }
}

// PATCH: Edit a sent message
export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string; jid: string; messageId: string }> }
) {
    try {
        const user = await getAuthenticatedUser(request);
        if (!user) {
            return NextResponse.json({ status: false, message: "Unauthorized", error: "Unauthorized" }, { status: 401 });
        }

        const { sessionId, jid, messageId } = await params;
        const body = await request.json().catch(() => ({}));
        const { text } = body;

        if (!text) {
            return NextResponse.json({ status: false, message: "Text is required to edit message", error: "Bad Request" }, { status: 400 });
        }

        const canAccess = await canAccessSession(user.id, user.role, sessionId);
        if (!canAccess) {
            return NextResponse.json({ status: false, message: "Forbidden - Cannot access this session", error: "Forbidden - Cannot access this session" }, { status: 403 });
        }

        const instance = waManager.getInstance(sessionId);
        if (!instance?.socket) {
            return NextResponse.json({ status: false, message: "Session not ready", error: "Session not ready" }, { status: 503 });
        }

        const decodedJid = decodeURIComponent(jid);

        await instance.socket.sendMessage(decodedJid, {
            text: text,
            edit: {
                remoteJid: decodedJid,
                id: messageId,
                fromMe: true
            }
        });

        return NextResponse.json({ status: true, message: "Message edited successfully" });
    } catch (error: any) {
        console.error("Edit message error:", error);
        return NextResponse.json({ status: false, message: "Failed to edit message", error: error.message || "Failed to edit message" }, { status: 500 });
    }
}
