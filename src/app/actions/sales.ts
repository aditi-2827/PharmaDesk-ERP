"use server";

import { and, asc, desc, eq, gt, gte, inArray, like, or, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, type DbExecutor } from "@/db";
import {
  batches,
  products,
  saleItems,
  sales,
  storeSettings,
  type Sale,
} from "@/db/schema";
import { AuthorizationError, requireOwner, requireUser } from "@/lib/authorization";
import { createAuditLog } from "@/lib/audit";
import { nextInvoiceNumber } from "@/lib/invoice-number";
import {
  computeSaleTotals,
  isInterStateTransaction,
  type PricedTotals,
} from "@/lib/pricing";
import { gstinSchema } from "@/lib/validation";

const saleItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string().trim().max(200).optional(),
  quantity: z.number().int().min(1).max(10_000),
});

const saleSchema = z.object({
  customerName: z.string().trim().max(200).nullable().optional(),
  customerPhone: z.string().trim().max(20).nullable().optional(),
  customerGstin: gstinSchema.nullable().optional(),
  paymentMode: z.enum(["cash", "card", "upi", "credit"]),
  discount: z.number().int().min(0).max(100_000_000).optional().default(0),
  items: z.array(saleItemSchema).min(1).max(200),
});

const previewSchema = saleSchema.pick({
  customerGstin: true,
  discount: true,
  items: true,
});

export type SaleInput = z.infer<typeof saleSchema>;
export type SaleItemInput = z.infer<typeof saleItemSchema>;

type Allocation = {
  productId: string;
  productName: string;
  batchId: string;
  batchNumber: string;
  location: string | null;
  expiryDate: Date;
  mrp: number;
  saleRate: number;
  costRate: number;
  gstRate: number;
  quantity: number;
  grossAmount: number;
};

type PickListItem = {
  productId: string;
  productName: string;
  batchNumber: string;
  location: string;
  quantityToPick: number;
  expiryDate: Date;
  saleRate: number;
};

type SaleSuccess = {
  success: true;
  sale: Sale;
  totals: PricedTotals;
};

type PreviewSuccess = {
  success: true;
  pickList: PickListItem[];
  totals: PricedTotals;
};

class SaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaleError";
  }
}

function actionError(error: unknown): string {
  if (error instanceof AuthorizationError) throw error;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid sale data";
  }
  if (error instanceof SaleError) return error.message;

  console.error("Sale action failed", error);
  return "Unable to complete the sale. Please try again.";
}

async function prepareAllocations(
  executor: DbExecutor,
  items: SaleItemInput[]
): Promise<Allocation[]> {
  const merged = new Map<string, { productId: string; productName?: string; quantity: number }>();

  for (const item of items) {
    const existing = merged.get(item.productId);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      merged.set(item.productId, { ...item });
    }
  }

  const productIds = Array.from(merged.keys());
  const productRows = await executor
    .select({
      id: products.id,
      name: products.name,
      gstRate: products.gstRate,
      isActive: products.isActive,
    })
    .from(products)
    .where(inArray(products.id, productIds));

  const productMap = new Map(productRows.map((product) => [product.id, product]));
  const now = new Date();

  const batchRows = await executor
    .select()
    .from(batches)
    .where(
      and(
        inArray(batches.productId, productIds),
        gt(batches.stock, 0),
        gt(batches.expiryDate, now)
      )
    )
    .orderBy(asc(batches.expiryDate), asc(batches.id));

  const batchesByProduct = new Map<string, typeof batchRows>();
  for (const batch of batchRows) {
    const list = batchesByProduct.get(batch.productId) ?? [];
    list.push(batch);
    batchesByProduct.set(batch.productId, list);
  }

  const allocations: Allocation[] = [];

  for (const item of merged.values()) {
    const product = productMap.get(item.productId);
    if (!product || !product.isActive) {
      throw new SaleError(`Product is no longer available: ${item.productName || item.productId}`);
    }

    const productBatches = batchesByProduct.get(item.productId) ?? [];
    const available = productBatches.reduce((sum, batch) => sum + batch.stock, 0);

    if (available < item.quantity) {
      throw new SaleError(
        `Insufficient unexpired stock for ${product.name}. Available: ${available}, requested: ${item.quantity}`
      );
    }

    let remaining = item.quantity;
    for (const batch of productBatches) {
      if (remaining <= 0) break;

      const quantity = Math.min(batch.stock, remaining);
      remaining -= quantity;

      allocations.push({
        productId: product.id,
        productName: product.name,
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        location: batch.location,
        expiryDate: batch.expiryDate,
        mrp: batch.mrp,
        saleRate: batch.saleRate,
        costRate: batch.purchaseRate,
        gstRate: product.gstRate,
        quantity,
        grossAmount: batch.saleRate * quantity,
      });
    }
  }

  return allocations;
}

export async function createSale(data: SaleInput): Promise<SaleSuccess | { success: false; error: string }> {
  const actor = await requireUser();

  try {
    const parsed = saleSchema.parse(data);
    const settings = await db.query.storeSettings.findFirst({
      where: eq(storeSettings.id, 1),
    });

    const interState = isInterStateTransaction(
      settings?.gstin,
      parsed.customerGstin,
      settings?.isInterStateDefault ?? false
    );

    const allocations = await prepareAllocations(db, parsed.items);
    const gross = allocations.reduce((sum, line) => sum + line.grossAmount, 0);

    if (parsed.discount > gross) {
      throw new SaleError("Discount cannot exceed the gross sale amount");
    }

    const totals = computeSaleTotals(allocations, parsed.discount, interState);
    const now = new Date();

    const result = await db.transaction(async (tx) => {
      const invoiceNumber = await nextInvoiceNumber(tx, settings?.invoicePrefix, now);

      const [sale] = await tx
        .insert(sales)
        .values({
          invoiceNumber,
          customerName: parsed.customerName || null,
          customerPhone: parsed.customerPhone || null,
          customerGstin: parsed.customerGstin?.toUpperCase() || null,
          invoiceDate: now,
          paymentMode: parsed.paymentMode,
          subtotal: totals.subtotal,
          discount: totals.discount,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          totalAmount: totals.totalAmount,
          createdBy: actor.id,
        })
        .returning();

      for (const [index, allocation] of allocations.entries()) {
        const priced = totals.lines[index];
        if (!priced) throw new SaleError("Unable to price sale item");

        const updated = await tx
          .update(batches)
          .set({
            stock: sql`${batches.stock} - ${allocation.quantity}`,
            updatedAt: now,
          })
          .where(
            and(
              eq(batches.id, allocation.batchId),
              gte(batches.stock, allocation.quantity)
            )
          )
          .returning({ id: batches.id });

        if (updated.length === 0) {
          throw new SaleError(
            `Stock for ${allocation.productName} (batch ${allocation.batchNumber}) changed during checkout. Please retry.`
          );
        }

        await tx.insert(saleItems).values({
          saleId: sale.id,
          productId: allocation.productId,
          batchId: allocation.batchId,
          quantity: allocation.quantity,
          saleRate: allocation.saleRate,
          costRate: allocation.costRate,
          mrp: allocation.mrp,
          gstRate: allocation.gstRate,
          taxableAmount: priced.taxableAmount,
          cgstAmount: priced.cgstAmount,
          sgstAmount: priced.sgstAmount,
          igstAmount: priced.igstAmount,
          totalAmount: priced.totalAmount,
        });
      }

      await createAuditLog(tx, {
        userId: actor.id,
        action: "SALE_CREATED",
        entityType: "sale",
        entityId: sale.id,
        details: {
          invoiceNumber,
          totalAmount: totals.totalAmount,
          discount: totals.discount,
          itemCount: allocations.length,
          paymentMode: parsed.paymentMode,
        },
      });

      return sale;
    });

    revalidatePath("/billing");
    revalidatePath("/sales");
    revalidatePath("/inventory");
    revalidatePath("/");
    revalidatePath("/gst");
    revalidatePath("/reports");

    return { success: true, sale: result, totals };
  } catch (error) {
    return { success: false, error: actionError(error) };
  }
}

export async function searchProductsForBilling(query: string = "") {
  await requireUser();

  const trimmed = query.trim().slice(0, 100);

  try {
    const productRows = await db
      .select({
        id: products.id,
        name: products.name,
        genericName: products.genericName,
        packSize: products.packSize,
        gstRate: products.gstRate,
        hsnCode: products.hsnCode,
      })
      .from(products)
      .where(
        trimmed.length >= 2
          ? and(
              eq(products.isActive, true),
              or(
                like(products.name, `%${trimmed}%`),
                like(products.genericName, `%${trimmed}%`),
                like(products.hsnCode, `%${trimmed}%`)
              )
            )
          : eq(products.isActive, true)
      )
      .limit(20);

    if (productRows.length === 0) return { success: true as const, data: [] };

    const ids = productRows.map((product) => product.id);
    const now = new Date();
    const batchRows = await db
      .select({
        productId: batches.productId,
        stock: batches.stock,
        saleRate: batches.saleRate,
        mrp: batches.mrp,
        expiryDate: batches.expiryDate,
      })
      .from(batches)
      .where(
        and(
          inArray(batches.productId, ids),
          gt(batches.stock, 0),
          gt(batches.expiryDate, now)
        )
      )
      .orderBy(asc(batches.expiryDate));

    const stockByProduct = new Map<
      string,
      { totalStock: number; saleRate: number | null; mrp: number | null }
    >();

    for (const batch of batchRows) {
      const current = stockByProduct.get(batch.productId) ?? {
        totalStock: 0,
        saleRate: batch.saleRate,
        mrp: batch.mrp,
      };
      current.totalStock += batch.stock;
      stockByProduct.set(batch.productId, current);
    }

    const data = productRows
      .map((product) => {
        const stock = stockByProduct.get(product.id);
        return {
          ...product,
          totalStock: stock?.totalStock ?? 0,
          saleRate: stock?.saleRate ?? null,
          mrp: stock?.mrp ?? null,
        };
      })
      .filter((product) => product.totalStock > 0)
      .slice(0, 10);

    return { success: true as const, data };
  } catch (error) {
    console.error("Billing search failed", error);
    return { success: false as const, error: "Search failed", data: [] };
  }
}

export async function previewSale(data: {
  items: SaleItemInput[];
  discount?: number;
  customerGstin?: string;
}): Promise<PreviewSuccess | { success: false; error: string }> {
  await requireUser();

  try {
    const parsed = previewSchema.parse(data);
    const settings = await db.query.storeSettings.findFirst({
      where: eq(storeSettings.id, 1),
    });
    const interState = isInterStateTransaction(
      settings?.gstin,
      parsed.customerGstin,
      settings?.isInterStateDefault ?? false
    );

    const allocations = await prepareAllocations(db, parsed.items);
    const gross = allocations.reduce((sum, line) => sum + line.grossAmount, 0);
    const discount = parsed.discount ?? 0;

    if (discount > gross) {
      throw new SaleError("Discount cannot exceed the gross sale amount");
    }

    const totals = computeSaleTotals(allocations, discount, interState);
    const pickList = allocations.map<PickListItem>((line) => ({
      productId: line.productId,
      productName: line.productName,
      batchNumber: line.batchNumber,
      location: line.location || "Unassigned",
      quantityToPick: line.quantity,
      expiryDate: line.expiryDate,
      saleRate: line.saleRate,
    }));

    return { success: true, pickList, totals };
  } catch (error) {
    return { success: false, error: actionError(error) };
  }
}

export async function getSales() {
  await requireOwner();

  try {
    const results = await db
      .select({
        id: sales.id,
        invoiceNumber: sales.invoiceNumber,
        customerName: sales.customerName,
        customerPhone: sales.customerPhone,
        invoiceDate: sales.invoiceDate,
        paymentMode: sales.paymentMode,
        subtotal: sales.subtotal,
        discount: sales.discount,
        cgst: sales.cgst,
        sgst: sales.sgst,
        igst: sales.igst,
        totalAmount: sales.totalAmount,
      })
      .from(sales)
      .orderBy(desc(sales.invoiceDate))
      .limit(500);

    return { success: true as const, data: results };
  } catch (error) {
    console.error("Failed to fetch sales", error);
    return { success: false as const, data: [], error: "Failed to fetch sales" };
  }
}

export async function getSaleDetails(saleId: string) {
  await requireOwner();
  return loadSaleDetails(saleId);
}

export async function getSaleForInvoice(saleId: string) {
  const actor = await requireUser();

  const result = await loadSaleDetails(saleId);
  if (!result.success) return result;

  if (actor.role !== "owner" && result.sale.createdBy !== actor.id) {
    throw new AuthorizationError("You cannot access this invoice", 403);
  }

  return result;
}

async function loadSaleDetails(saleId: string) {
  const parsedId = z.string().uuid().safeParse(saleId);
  if (!parsedId.success) {
    return { success: false as const, error: "Invalid sale id" };
  }

  try {
    const sale = await db.query.sales.findFirst({
      where: eq(sales.id, parsedId.data),
    });

    if (!sale) return { success: false as const, error: "Sale not found" };

    const items = await db
      .select({
        id: saleItems.id,
        quantity: saleItems.quantity,
        saleRate: saleItems.saleRate,
        mrp: saleItems.mrp,
        gstRate: saleItems.gstRate,
        taxableAmount: saleItems.taxableAmount,
        cgstAmount: saleItems.cgstAmount,
        sgstAmount: saleItems.sgstAmount,
        igstAmount: saleItems.igstAmount,
        totalAmount: saleItems.totalAmount,
        productName: products.name,
        packSize: products.packSize,
        hsnCode: products.hsnCode,
        batchNumber: batches.batchNumber,
        expiryDate: batches.expiryDate,
      })
      .from(saleItems)
      .innerJoin(products, eq(saleItems.productId, products.id))
      .innerJoin(batches, eq(saleItems.batchId, batches.id))
      .where(eq(saleItems.saleId, parsedId.data));

    const settings = await db.query.storeSettings.findFirst({
      where: eq(storeSettings.id, 1),
    });

    return { success: true as const, sale, items, settings: settings ?? null };
  } catch (error) {
    console.error("Failed to load sale", error);
    return { success: false as const, error: "Failed to fetch sale details" };
  }
}
