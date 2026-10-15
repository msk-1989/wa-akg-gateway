import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
    let { pathname } = request.nextUrl;

    // Strip trailing slash to prevent redirect loop with gateway proxy
    // (the gateway adds trailing slashes, Next.js skips redirect with skipTrailingSlashRedirect)
    // We rewrite internally so Next.js routes to the right page
    let cleanUrl: URL | null = null;
    if (pathname.length > 1 && pathname.endsWith("/")) {
        cleanUrl = request.nextUrl.clone();
        cleanUrl.pathname = pathname.slice(0, -1);
        pathname = cleanUrl.pathname;
    }

    // Helper: return rewrite if we stripped a slash, otherwise next
    const pass = () => cleanUrl ? NextResponse.rewrite(cleanUrl) : NextResponse.next();

    // Public routes that don't require authentication
    const publicRoutes = ["/auth/login", "/auth/register", "/api/auth", "/api/test", "/terms", "/privacy"];
    const isPublicRoute = publicRoutes.some(route => pathname.startsWith(route));

    // Allow Next.js internals and favicon only
    if (pathname.startsWith("/_next") || pathname === "/favicon.ico") {
        return NextResponse.next();
    }

    // Allow known static asset extensions in root path only
    const staticExtensions = [".svg", ".ico", ".png", ".jpg", ".jpeg", ".webp", ".woff", ".woff2", ".ttf"];
    if (pathname.lastIndexOf("/") === 0 && staticExtensions.some(ext => pathname.endsWith(ext))) {
        return NextResponse.next();
    }

    // API routes: Check for API key or session
    if (pathname.startsWith("/api/")) {
        if (pathname.startsWith("/api/auth") || pathname.startsWith("/api/test") || pathname.startsWith("/api/health")) {
            return pass();
        }
        const apiKey = request.headers.get("x-api-key");
        if (apiKey) return pass();
        const session = await auth();
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        return pass();
    }

    // Dashboard routes: Require login
    if (pathname.startsWith("/dashboard")) {
        const session = await auth();
        if (!session?.user) {
            const loginUrl = new URL("/auth/login", request.url);
            loginUrl.searchParams.set("callbackUrl", pathname);
            return NextResponse.redirect(loginUrl);
        }
        return pass();
    }

    // Root path — redirect to dashboard if logged in
    if (pathname === "/") {
        const session = await auth();
        if (session?.user) {
            return NextResponse.redirect(new URL("/dashboard", request.url));
        }
        return NextResponse.next();
    }

    // Public routes
    if (isPublicRoute) {
        const session = await auth();
        if (session?.user && (pathname.startsWith("/auth/login") || pathname.startsWith("/auth/register"))) {
            return NextResponse.redirect(new URL("/dashboard", request.url));
        }
        return pass();
    }

    // Default: require auth for everything else
    const session = await auth();
    if (!session?.user) {
        const loginUrl = new URL("/auth/login", request.url);
        loginUrl.searchParams.set("callbackUrl", pathname);
        return NextResponse.redirect(loginUrl);
    }

    return pass();
}

export const config = {
    matcher: [
        "/((?!_next/static|_next/image|favicon.ico).*)",
    ],
};
