import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authConfig } from "./auth.config";
import { checkLoginAllowed, clearLoginFailures, loginKey, recordLoginFailure } from "./rate-limit";
import { emailSchema } from "./validation";

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: {
    strategy: "jwt",
    maxAge: 24 * 60 * 60,
    updateAge: 60 * 60,
  },
  callbacks: {
    ...authConfig.callbacks,
      async jwt({ token, user }) {
        if (user) {
          token.id = (user as any).id;
          token.role = (user as any).role;
          token.name = (user as any).name;
          token.sessionVersion = (user as any).sessionVersion;
          return token;
        }

        if (!token.id) return token;

        const currentUser = await db.query.users.findFirst({
          where: eq(users.id, token.id as string),
          columns: {
            id: true,
            name: true,
            role: true,
            isActive: true,
            sessionVersion: true,
          },
        });

      if (
        !currentUser ||
        !currentUser.isActive ||
        currentUser.sessionVersion !== (token.sessionVersion as number | undefined)
      ) {
        token.id = "";
        token.role = "staff";
        token.name = "";
        return token;
      }

      token.role = currentUser.role;
      token.name = currentUser.name;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? "";
        session.user.role = token.role === "owner" ? "owner" : "staff";
        session.user.name = (token.name as string) ?? "";
        session.user.sessionVersion = (token.sessionVersion as number) ?? 0;
      }
      return session;
    },
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const { email, password } = parsed.data;
        const key = loginKey(email);
        const limit = checkLoginAllowed(key);
        if (!limit.allowed) return null;

        const user = await db.query.users.findFirst({
          where: eq(users.email, email),
        });

        if (!user || !user.isActive) {
          recordLoginFailure(key);
          return null;
        }

        const passwordMatch = await bcrypt.compare(password, user.passwordHash);
        if (!passwordMatch) {
          recordLoginFailure(key);
          return null;
        }

        clearLoginFailures(key);

        await db
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, user.id));

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          sessionVersion: user.sessionVersion,
        };
      },
    }),
  ],
});
