import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users, type User } from "@/db/schema";

export class AuthorizationError extends Error {
  readonly status: 401 | 403;

  constructor(message: string, status: 401 | 403) {
    super(message);
    this.name = "AuthorizationError";
    this.status = status;
  }
}

export const getCurrentUser = cache(async (): Promise<User | null> => {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) return null;

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  if (
    !user ||
    !user.isActive ||
    user.sessionVersion !== (session.user.sessionVersion ?? 0)
  ) {
    return null;
  }

  return user;
});

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AuthorizationError("Authentication required", 401);
  return user;
}

export async function requireOwner(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "owner") throw new AuthorizationError("Owner access required", 403);
  return user;
}

export async function requireUserPage(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireOwnerPage(): Promise<User> {
  const user = await requireUserPage();
  if (user.role !== "owner") redirect("/?forbidden=1");
  return user;
}

export function isOwner(user: Pick<User, "role"> | null | undefined): boolean {
  return user?.role === "owner";
}
