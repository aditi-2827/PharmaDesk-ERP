"use server";

import { and, desc, eq, gte, like, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { requireOwner } from "@/lib/authorization";

export type AuditLogFilters = {
  action?: string;
  entityType?: string;
  from?: string;
  to?: string;
};

export async function getAuditLogs(page = 1, limit = 50, filters: AuditLogFilters = {}) {
  await requireOwner();

  const safePage = Math.max(1, Math.trunc(page));
  const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  const offset = (safePage - 1) * safeLimit;

  const conditions = [];

  if (filters.action) {
    conditions.push(like(auditLogs.action, `%${filters.action.toUpperCase()}%`));
  }
  if (filters.entityType) {
    conditions.push(eq(auditLogs.entityType, filters.entityType));
  }
  if (filters.from) {
    const from = new Date(filters.from);
    if (!Number.isNaN(from.getTime())) conditions.push(gte(auditLogs.createdAt, from));
  }
  if (filters.to) {
    const to = new Date(filters.to);
    if (!Number.isNaN(to.getTime())) conditions.push(lte(auditLogs.createdAt, to));
  }

  const where = conditions.length ? and(...conditions) : undefined;

  try {
    const [logs, countRows] = await Promise.all([
      db
        .select({
          id: auditLogs.id,
          userId: auditLogs.userId,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          details: auditLogs.details,
          createdAt: auditLogs.createdAt,
          userName: users.name,
        })
        .from(auditLogs)
        .leftJoin(users, eq(auditLogs.userId, users.id))
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(safeLimit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(auditLogs)
        .where(where),
    ]);

    return {
      success: true as const,
      data: logs,
      total: countRows[0]?.count ?? 0,
      page: safePage,
      limit: safeLimit,
    };
  } catch {
    return { success: false as const, error: "Failed to fetch audit logs" };
  }
}
