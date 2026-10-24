"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AuthorizationError, requireOwner } from "@/lib/authorization";
import { createAuditLog } from "@/lib/audit";
import { emailSchema, passwordSchema } from "@/lib/validation";

const userSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(["owner", "staff"]),
});

export type UserInput = z.infer<typeof userSchema>;

function actionError(error: unknown): string {
  if (error instanceof AuthorizationError) throw error;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid user data";
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE constraint failed")) return "Email already exists";

  console.error("User action failed", error);
  return "Unable to complete the user operation. Please try again.";
}

export async function addUser(data: UserInput) {
  const actor = await requireOwner();

  try {
    const parsed = userSchema.parse(data);
    const passwordHash = await bcrypt.hash(parsed.password, 12);

    const [user] = await db
      .insert(users)
      .values({
        name: parsed.name,
        email: parsed.email,
        passwordHash,
        role: parsed.role,
        isActive: true,
      })
      .returning({ id: users.id, name: users.name, email: users.email, role: users.role });

    await createAuditLog(db, {
      userId: actor.id,
      action: "USER_CREATED",
      entityType: "user",
      entityId: user.id,
      details: { name: user.name, email: user.email, role: user.role },
    });

    revalidatePath("/users");
    return { success: true as const };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function toggleUserStatus(id: string, isActive: boolean) {
  const actor = await requireOwner();

  try {
    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) return { error: "Invalid user id" };
    if (typeof isActive !== "boolean") return { error: "Invalid status" };
    if (parsedId.data === actor.id) return { error: "You cannot disable your own account" };

    const target = await db.query.users.findFirst({
      where: eq(users.id, parsedId.data),
      columns: { id: true, name: true, role: true, isActive: true },
    });

    if (!target) return { error: "User not found" };

    if (!isActive && target.role === "owner") {
      const [ownerCount] = await db
        .select({ count: sql<number>`count(*)` })
        .from(users)
        .where(and(eq(users.role, "owner"), eq(users.isActive, true)));

      if (Number(ownerCount?.count ?? 0) <= 1) {
        return { error: "At least one active owner account is required" };
      }
    }

    await db
      .update(users)
      .set({ isActive, sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, target.id));

    await createAuditLog(db, {
      userId: actor.id,
      action: isActive ? "USER_ENABLED" : "USER_DISABLED",
      entityType: "user",
      entityId: target.id,
      details: { name: target.name, role: target.role },
    });

    revalidatePath("/users");
    return { success: true as const };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function resetUserPassword(id: string, newPassword: string) {
  const actor = await requireOwner();

  try {
    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) return { error: "Invalid user id" };

    const parsedPassword = passwordSchema.safeParse(newPassword);
    if (!parsedPassword.success) {
      return { error: parsedPassword.error.issues[0]?.message ?? "Invalid password" };
    }

    const target = await db.query.users.findFirst({
      where: eq(users.id, parsedId.data),
      columns: { id: true, name: true },
    });

    if (!target) return { error: "User not found" };

    const passwordHash = await bcrypt.hash(parsedPassword.data, 12);

    await db
      .update(users)
      .set({
        passwordHash,
        sessionVersion: sql`${users.sessionVersion} + 1`,
      })
      .where(eq(users.id, target.id));

    await createAuditLog(db, {
      userId: actor.id,
      action: "USER_PASSWORD_RESET",
      entityType: "user",
      entityId: target.id,
      details: { name: target.name },
    });

    revalidatePath("/users");
    return { success: true as const };
  } catch (error) {
    return { error: actionError(error) };
  }
}
