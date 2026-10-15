import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { authConfig } from "@/auth.config";

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
          // Extract and normalize credentials without zod (avoids v4 parse issues)
          const rawEmail = credentials?.email as string;
          const rawPassword = credentials?.password as string;

          if (!rawEmail || !rawPassword || typeof rawEmail !== "string" || typeof rawPassword !== "string") {
            console.log("[auth] Missing or invalid credentials");
            return null;
          }

          // Lowercase + trim the email for case-insensitive lookup
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

          // Return only the fields NextAuth needs — NEVER include password
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
  secret: process.env.AUTH_SECRET,
});
