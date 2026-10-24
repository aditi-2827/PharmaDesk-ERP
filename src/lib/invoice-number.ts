import { sql } from "drizzle-orm";
import { invoiceCounters } from "@/db/schema";
import type { DbTransaction } from "@/db";

const PREFIX_PATTERN = /[^A-Z0-9-]/g;

export function sanitizeInvoicePrefix(prefix: string | null | undefined): string {
  const normalized = (prefix ?? "INV").trim().toUpperCase().replace(PREFIX_PATTERN, "-");
  const compact = normalized.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return compact.slice(0, 16) || "INV";
}

export async function nextInvoiceNumber(
  tx: DbTransaction,
  prefix: string | null | undefined,
  date = new Date()
): Promise<string> {
  const safePrefix = sanitizeInvoicePrefix(prefix);
  const year = date.getFullYear();
  const key = `${safePrefix}:${year}`;

  const rows = await tx
    .insert(invoiceCounters)
    .values({ key, value: 1 })
    .onConflictDoUpdate({
      target: invoiceCounters.key,
      set: {
        value: sql`${invoiceCounters.value} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ value: invoiceCounters.value });

  const sequence = rows[0]?.value;
  if (!sequence) {
    throw new Error("Unable to generate an invoice number");
  }

  return `${safePrefix}-${year}-${String(sequence).padStart(6, "0")}`;
}
