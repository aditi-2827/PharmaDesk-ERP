import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { products } from "./products";
import { batches } from "./batches";
import { users } from "./users";

export const sales = sqliteTable(
  "sales",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    invoiceNumber: text("invoice_number").notNull().unique(),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    customerGstin: text("customer_gstin"),
    invoiceDate: integer("invoice_date", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    paymentMode: text("payment_mode", { enum: ["cash", "card", "upi", "credit"] }).notNull().default("cash"),
    subtotal: integer("subtotal").notNull(),
    discount: integer("discount").notNull().default(0),
    cgst: integer("cgst").notNull().default(0),
    sgst: integer("sgst").notNull().default(0),
    igst: integer("igst").notNull().default(0),
    totalAmount: integer("total_amount").notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("sales_invoice_date_idx").on(table.invoiceDate),
    index("sales_created_by_idx").on(table.createdBy),
    index("sales_payment_mode_idx").on(table.paymentMode),
  ]
);

export const saleItems = sqliteTable(
  "sale_items",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    saleId: text("sale_id").notNull().references(() => sales.id),
    productId: text("product_id").notNull().references(() => products.id),
    batchId: text("batch_id").notNull().references(() => batches.id),
    quantity: integer("quantity").notNull(),
    saleRate: integer("sale_rate").notNull(),
    costRate: integer("cost_rate").notNull().default(0),
    mrp: integer("mrp").notNull(),
    gstRate: integer("gst_rate").notNull(),
    taxableAmount: integer("taxable_amount").notNull(),
    cgstAmount: integer("cgst_amount").notNull().default(0),
    sgstAmount: integer("sgst_amount").notNull().default(0),
    igstAmount: integer("igst_amount").notNull().default(0),
    totalAmount: integer("total_amount").notNull(),
  },
  (table) => [
    index("sale_items_sale_id_idx").on(table.saleId),
    index("sale_items_product_id_idx").on(table.productId),
    index("sale_items_batch_id_idx").on(table.batchId),
  ]
);

export type Sale = typeof sales.$inferSelect;
export type NewSale = typeof sales.$inferInsert;
export type SaleItem = typeof saleItems.$inferSelect;
export type NewSaleItem = typeof saleItems.$inferInsert;
