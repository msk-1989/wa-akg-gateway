import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { authConfig } from "@/auth.config";
import { randomBytes, createHash } from "crypto";

// Generate a fallback secret if AUTH_SECRET is not set in env.
// This prevents the "There was a problem with the server configuration" 500 error
// when the sandbox wipes .env. The fallback is stable per-process (not per-request)
// so sessions work within a single server run.
function getAuthSecret(): string {
  const envSecret = process.env.AUTH_SECRET;
  if (envSecret && envSecret.length > 10) return envSecret;

  // Fallback: derive a stable secret from the DATABASE_URL + a fixed salt
  // This is NOT secure for production — only used as a dev fallback
  const dbUrl = process.env.DATABASE_URL || "fallback-db-url";
  const hash = createHash("sha256").update(`wa-akg-secret:${dbUrl}`).digest("base64");
  console.warn("[auth] WARNING: AUTH_SECRET not set in env — using derived fallback. Set AUTH_SECRET for production.");
  return hash;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        try {
          const rawEmail = credentials?.email as string;
          const rawPassword = credentials?.password as string;

          if (!rawEmail || !rawPassword || typeof rawEmail !== "string" || typeof rawPassword !== "string") {
            console.log("[auth] Missing or invalid credentials");
            return null;
          }

          const email = rawEmail.toLowerCase().trim();
          const password = rawPassword;

          if (password.length < 1) {
            console.log("[auth] Password too short");
            return null;
          }

          const user = await prisma.user.findUnique({ where: { email } });
          if (!user) {
            console.log("[auth] No user found for email:", email);
            return null;
          }

          const passwordsMatch = await bcrypt.compare(password, user.password);
          if (!passwordsMatch) {
            console.log("[auth] Password mismatch for:", email);
            return null;
          }

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
          };
        } catch (error) {
          console.error("[auth] Authorize error:", error);
          return null;
        }
      },
    }),
  ],
  secret: getAuthSecret(),
});
