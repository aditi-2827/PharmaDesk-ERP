import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { products } from "./products";

export const batches = sqliteTable(
  "batches",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    productId: text("product_id").notNull().references(() => products.id),
    batchNumber: text("batch_number").notNull(),
    expiryDate: integer("expiry_date", { mode: "timestamp" }).notNull(),
    mrp: integer("mrp").notNull(),
    purchaseRate: integer("purchase_rate").notNull(),
    saleRate: integer("sale_rate").notNull(),
    stock: integer("stock").notNull().default(0),
    location: text("location"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("batches_product_id_idx").on(table.productId),
    index("batches_expiry_date_idx").on(table.expiryDate),
    index("batches_stock_idx").on(table.stock),
    uniqueIndex("batches_identity_idx").on(table.productId, table.batchNumber, table.expiryDate),
  ]
);

export type Batch = typeof batches.$inferSelect;
export type NewBatch = typeof batches.$inferInsert;
