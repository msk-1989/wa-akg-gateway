import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
    try {
        console.log("Checking DB connection...");
        const sessionCount = await prisma.session.count();
        console.log("Total Sessions:", sessionCount);

        const latestSession = await prisma.session.findFirst({
            orderBy: { createdAt: 'desc' }
        });

        if (!latestSession) {
            console.log("No sessions found.");
            return;
        }
        console.log("Latest Session:", latestSession.id, latestSession.sessionId);

        const msgCount = await prisma.message.count();
        console.log("Total Messages:", msgCount);

        const latestMessages = await prisma.message.findMany({
            take: 5,
            orderBy: { timestamp: 'desc' }
        });
        console.log("Latest 5 Messages:", JSON.stringify(latestMessages, null, 2));

        // Try to insert a dummy message
        console.log("Attempting to insert a dummy message...");
        const msg = await prisma.message.create({
            data: {
                sessionId: latestSession.id,
                remoteJid: "1234567890@s.whatsapp.net",
                senderJid: "1234567890@s.whatsapp.net",
                fromMe: false,
                keyId: "DUMMY_KEY_" + Date.now(),
                pushName: "Test User",
                type: "TEXT",
                content: "dummy message",
                status: "PENDING",
                timestamp: new Date()
            }
        });
        console.log("Successfully inserted dummy message:", msg.id);

        // Clean up dummy message
        await prisma.message.delete({ where: { id: msg.id } });
        console.log("Successfully deleted dummy message.");

    } catch (e) {
        console.error("Error connecting to DB or performing operations:", e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
