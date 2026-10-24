import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { products } from "./products";
import { batches } from "./batches";
import { suppliers } from "./suppliers";
import { users } from "./users";

export const purchases = sqliteTable(
  "purchases",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    supplierId: text("supplier_id").notNull().references(() => suppliers.id),
    invoiceNumber: text("invoice_number").notNull(),
    purchaseDate: integer("purchase_date", { mode: "timestamp" }).notNull(),
    paymentStatus: text("payment_status", { enum: ["paid", "pending", "partial"] }).notNull().default("pending"),
    subtotal: integer("subtotal").notNull(),
    discount: integer("discount").notNull().default(0),
    cgst: integer("cgst").notNull().default(0),
    sgst: integer("sgst").notNull().default(0),
    igst: integer("igst").notNull().default(0),
    totalAmount: integer("total_amount").notNull(),
    notes: text("notes"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("purchases_supplier_id_idx").on(table.supplierId),
    index("purchases_purchase_date_idx").on(table.purchaseDate),
    uniqueIndex("purchases_supplier_invoice_idx").on(table.supplierId, table.invoiceNumber),
  ]
);

export const purchaseItems = sqliteTable(
  "purchase_items",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    purchaseId: text("purchase_id").notNull().references(() => purchases.id),
    productId: text("product_id").notNull().references(() => products.id),
    batchId: text("batch_id").notNull().references(() => batches.id),
    quantity: integer("quantity").notNull(),
    freeQuantity: integer("free_quantity").notNull().default(0),
    purchaseRate: integer("purchase_rate").notNull(),
    mrp: integer("mrp").notNull(),
    saleRate: integer("sale_rate").notNull(),
    gstRate: integer("gst_rate").notNull().default(0),
    taxableAmount: integer("taxable_amount").notNull().default(0),
    cgstAmount: integer("cgst_amount").notNull().default(0),
    sgstAmount: integer("sgst_amount").notNull().default(0),
    igstAmount: integer("igst_amount").notNull().default(0),
    totalAmount: integer("total_amount").notNull(),
  },
  (table) => [
    index("purchase_items_purchase_id_idx").on(table.purchaseId),
    index("purchase_items_product_id_idx").on(table.productId),
    index("purchase_items_batch_id_idx").on(table.batchId),
  ]
);

export type Purchase = typeof purchases.$inferSelect;
export type NewPurchase = typeof purchases.$inferInsert;
export type PurchaseItem = typeof purchaseItems.$inferSelect;
export type NewPurchaseItem = typeof purchaseItems.$inferInsert;
