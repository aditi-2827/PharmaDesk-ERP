import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const invoiceCounters = sqliteTable("invoice_counters", {
  key: text("key").primaryKey(),
  value: integer("value").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export type InvoiceCounter = typeof invoiceCounters.$inferSelect;
export type NewInvoiceCounter = typeof invoiceCounters.$inferInsert;
