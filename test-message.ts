import { PrismaClient } from "@prisma/client";
import { normalizeJid, resolveToPhoneJid, isLidJid } from "./src/lib/jid-utils";

const prisma = new PrismaClient();

async function simulate() {
    console.log("Starting simulation...");
    const session = await prisma.session.findFirst();
    if (!session) {
        console.log("No session found");
        return;
    }
    const dbSessionId = session.id;
    const sessionId = session.sessionId;

    const fromMe = false;
    const remoteJid = "1234567890@s.whatsapp.net";
    const normalizedRemoteJid = remoteJid;
    const keyId = "SIMKEY_" + Date.now();
    const pushName = "Sim User";
    const messageType = "TEXT";
    const text = "Simulation test";
    const fileUrl = null;
    const timestamp = new Date();
    const senderJid = remoteJid;

    try {
        console.log("Creating message for dbSessionId:", dbSessionId);
        const newMessage = await prisma.message.create({
            data: {
                sessionId: dbSessionId,
                remoteJid: normalizeJid(normalizedRemoteJid),
                senderJid,
                fromMe,
                keyId,
                pushName,
                type: messageType as any,
                content: text,
                mediaUrl: fileUrl,
                status: fromMe ? "SENT" : "PENDING",
                timestamp
            }
        });
        console.log("Message created successfully:", newMessage.id);
    } catch (e: any) {
        console.error("Failed to create message:", e);
    }

    // Now contact upsert
    try {
        const finalRemoteJid = normalizeJid(normalizedRemoteJid);
        const contactJid = finalRemoteJid;
        console.log("Upserting contact:", contactJid);
        const contact = await prisma.contact.upsert({
            where: { sessionId_jid: { sessionId: dbSessionId, jid: contactJid } },
            create: {
                sessionId: dbSessionId,
                jid: contactJid,
                notify: pushName,
                name: pushName,
            },
            update: {
                notify: pushName,
            }
        });
        console.log("Contact upsert successful:", contact.id);
    } catch (e: any) {
        console.error("Failed to upsert contact:", e);
    }
}

simulate().finally(() => prisma.$disconnect());
