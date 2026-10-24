import { auditLogs } from "@/db/schema";
import type { DbExecutor } from "@/db";

export type AuditEntry = {
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details?: unknown;
};

export async function createAuditLog(executor: DbExecutor, entry: AuditEntry): Promise<void> {
  await executor.insert(auditLogs).values({
    userId: entry.userId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    details: entry.details === undefined ? null : JSON.stringify(entry.details),
  });
}
