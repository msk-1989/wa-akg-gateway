import { handlers } from "@/lib/auth";

// Wrap the NextAuth handlers to catch any errors and always return valid JSON
// This fixes the "Unexpected end of JSON input" error when the session route
// crashes silently (known NextAuth v5 beta + Turbopack issue)
async function safeHandler(req: Request) {
  try {
    const res = await handlers.GET(req);
    // If the response has no body or empty body, return a proper JSON response
    const text = await res.text();
    if (!text) {
      return new Response(JSON.stringify(null), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Return the original response with its body
    return new Response(text, {
      status: res.status,
      headers: res.headers,
    });
  } catch (error) {
    console.error("[auth] Handler error:", error);
    return new Response(JSON.stringify(null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function GET(req: Request) {
  return safeHandler(req);
}

export async function POST(req: Request) {
  try {
    return await handlers.POST(req);
  } catch (error) {
    console.error("[auth] POST handler error:", error);
    return new Response(JSON.stringify({ error: "Auth error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
