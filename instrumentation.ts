/**
 * Instrumentation — runs on Next.js server start.
 * Initializes the WhatsApp manager and scheduler without needing the custom
 * Socket.io server. Uses a mock Socket.io so the manager code works unchanged.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { MockServer } = await import("./src/lib/mock-socket");
    const { waManager } = await import("./src/modules/whatsapp/manager");
    const { startScheduler } = await import("./src/modules/whatsapp/scheduler");

    const mockIo = new MockServer() as any;
    (global as any).io = mockIo;

    try {
      waManager.setup(mockIo);
      // Delay to let DB connect
      setTimeout(async () => {
        try {
          await waManager.loadSessions();
          startScheduler();
          console.log("[instrumentation] WhatsApp manager and scheduler started");
        } catch (e) {
          console.error("[instrumentation] Failed to start WA manager:", e);
        }
      }, 2000);
    } catch (e) {
      console.error("[instrumentation] Setup error:", e);
    }
  }
}
