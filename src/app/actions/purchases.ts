"use server";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import {
  batches,
  products,
  purchaseItems,
  purchases,
  storeSettings,
  suppliers,
  type Purchase,
} from "@/db/schema";
import { AuthorizationError, requireOwner } from "@/lib/authorization";
import { createAuditLog } from "@/lib/audit";
import {
  computePurchaseTotals,
  isInterStateTransaction,
  type PricedTotals,
} from "@/lib/pricing";

const purchaseItemSchema = z.object({
  productId: z.string().uuid(),
  batchNumber: z.string().trim().min(1).max(100),
  expiryDate: z.coerce.date().refine(
    (date) => date.getTime() > new Date().setHours(0, 0, 0, 0),
    "Expiry date must be in the future"
  ),
  quantity: z.number().int().min(1).max(100_000),
  freeQuantity: z.number().int().min(0).max(100_000).optional().default(0),
  purchaseRate: z.number().int().min(0).max(100_000_000),
  saleRate: z.number().int().min(0).max(100_000_000),
  mrp: z.number().int().min(0).max(100_000_000),
  location: z.string().trim().max(100).optional(),
});

const purchaseSchema = z.object({
  invoiceNumber: z.string().trim().min(1).max(100),
  purchaseDate: z.coerce.date(),
  supplierId: z.string().uuid(),
  discount: z.number().int().min(0).max(100_000_000).optional().default(0),
  paymentStatus: z.enum(["paid", "pending", "partial"]),
  notes: z.string().trim().max(1_000).nullable().optional(),
});

export type PurchaseInput = z.infer<typeof purchaseSchema>;
export type PurchaseItemInput = z.infer<typeof purchaseItemSchema>;

type PurchaseSuccess = {
  success: true;
  data: Purchase;
  totals: PricedTotals;
};

class PurchaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchaseError";
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}

function actionError(error: unknown): string {
  if (error instanceof AuthorizationError) throw error;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid purchase data";
  }
  if (error instanceof PurchaseError) return error.message;
  if (isUniqueConstraintError(error)) {
    return "This supplier invoice number has already been recorded";
  }

  console.error("Purchase action failed", error);
  return "Unable to save the purchase. Please try again.";
}

export async function getPurchases() {
  await requireOwner();

  try {
    const allPurchases = await db
      .select({
        id: purchases.id,
        invoiceNumber: purchases.invoiceNumber,
        purchaseDate: purchases.purchaseDate,
        subtotal: purchases.subtotal,
        discount: purchases.discount,
        cgst: purchases.cgst,
        sgst: purchases.sgst,
        igst: purchases.igst,
        totalAmount: purchases.totalAmount,
        paymentStatus: purchases.paymentStatus,
        supplierName: suppliers.name,
      })
      .from(purchases)
      .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
      .orderBy(desc(purchases.purchaseDate))
      .limit(500);

    return { success: true as const, data: allPurchases };
  } catch (error) {
    console.error("Failed to fetch purchases", error);
    return { success: false as const, data: [], error: "Failed to fetch purchases" };
  }
}

export async function getPurchaseDetails(purchaseId: string) {
  await requireOwner();

  const parsedId = z.string().uuid().safeParse(purchaseId);
  if (!parsedId.success) {
    return { success: false as const, data: [], error: "Invalid purchase id" };
  }

  try {
    const details = await db
      .select({
        id: purchaseItems.id,
        productId: purchaseItems.productId,
        productName: products.name,
        batchNumber: batches.batchNumber,
        expiryDate: batches.expiryDate,
        quantity: purchaseItems.quantity,
        freeQuantity: purchaseItems.freeQuantity,
        purchaseRate: purchaseItems.purchaseRate,
        mrp: purchaseItems.mrp,
        saleRate: purchaseItems.saleRate,
        gstRate: purchaseItems.gstRate,
        taxableAmount: purchaseItems.taxableAmount,
        cgstAmount: purchaseItems.cgstAmount,
        sgstAmount: purchaseItems.sgstAmount,
        igstAmount: purchaseItems.igstAmount,
        totalAmount: purchaseItems.totalAmount,
      })
      .from(purchaseItems)
      .innerJoin(products, eq(purchaseItems.productId, products.id))
      .innerJoin(batches, eq(purchaseItems.batchId, batches.id))
      .where(eq(purchaseItems.purchaseId, parsedId.data));

    return { success: true as const, data: details };
  } catch (error) {
    console.error("Failed to fetch purchase details", error);
    return { success: false as const, data: [], error: "Failed to fetch purchase details" };
  }
}

export async function createPurchase(
  purchaseData: PurchaseInput,
  itemsData: PurchaseItemInput[]
): Promise<PurchaseSuccess | { success: false; error: string }> {
  const actor = await requireOwner();

  try {
    const parsedPurchase = purchaseSchema.parse(purchaseData);
    const parsedItems = z.array(purchaseItemSchema).min(1).max(500).parse(itemsData);

    const productIds = Array.from(new Set(parsedItems.map((item) => item.productId)));
    const [supplier, settings, productRows] = await Promise.all([
      db.query.suppliers.findFirst({
        where: and(eq(suppliers.id, parsedPurchase.supplierId), eq(suppliers.isActive, true)),
      }),
      db.query.storeSettings.findFirst({ where: eq(storeSettings.id, 1) }),
      db.select({ id: products.id, name: products.name, gstRate: products.gstRate, isActive: products.isActive })
        .from(products)
        .where(inArray(products.id, productIds)),
    ]);

    if (!supplier) throw new PurchaseError("Supplier not found or inactive");

    const productMap = new Map(productRows.map((product) => [product.id, product]));

    const interState = isInterStateTransaction(
      settings?.gstin,
      supplier.gstin,
      settings?.isInterStateDefault ?? false
    );

    for (const item of parsedItems) {
      const product = productMap.get(item.productId);
      if (!product || !product.isActive) {
        throw new PurchaseError(`Product is not available for purchase: ${item.productId}`);
      }
      if (item.saleRate > item.mrp) {
        throw new PurchaseError(`Sale rate cannot exceed MRP for ${product.name}`);
      }
    }

    const totals = computePurchaseTotals(
      parsedItems.map((item) => ({
        quantity: item.quantity,
        purchaseRate: item.purchaseRate,
        gstRate: productMap.get(item.productId)?.gstRate ?? 0,
      })),
      parsedPurchase.discount,
      interState
    );

    const gross = totals.lines.reduce((sum, line) => sum + line.grossAmount, 0);
    if (parsedPurchase.discount > gross) {
      throw new PurchaseError("Discount cannot exceed the purchase amount");
    }

    const existingInvoice = await db.query.purchases.findFirst({
      where: and(
        eq(purchases.supplierId, parsedPurchase.supplierId),
        eq(purchases.invoiceNumber, parsedPurchase.invoiceNumber)
      ),
      columns: { id: true },
    });

    if (existingInvoice) {
      throw new PurchaseError("This supplier invoice number has already been recorded");
    }

    const result = await db.transaction(async (tx) => {
      const [purchase] = await tx
        .insert(purchases)
        .values({
          supplierId: parsedPurchase.supplierId,
          invoiceNumber: parsedPurchase.invoiceNumber,
          purchaseDate: parsedPurchase.purchaseDate,
          paymentStatus: parsedPurchase.paymentStatus,
          subtotal: totals.subtotal,
          discount: totals.discount,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          totalAmount: totals.totalAmount,
          notes: parsedPurchase.notes || null,
          createdBy: actor.id,
        })
        .returning();

      for (const [index, item] of parsedItems.entries()) {
        const product = productMap.get(item.productId);
        const priced = totals.lines[index];
        if (!product || !priced) throw new PurchaseError("Unable to price purchase item");

        const existingBatch = await tx.query.batches.findFirst({
          where: and(
            eq(batches.productId, item.productId),
            eq(batches.batchNumber, item.batchNumber),
            eq(batches.expiryDate, item.expiryDate)
          ),
        });

        const stockQuantity = item.quantity + item.freeQuantity;

        let batchId: string;
        if (existingBatch) {
          const [updated] = await tx
            .update(batches)
            .set({
              stock: sql`${batches.stock} + ${stockQuantity}`,
              purchaseRate: item.purchaseRate,
              saleRate: item.saleRate,
              mrp: item.mrp,
              location: item.location || existingBatch.location,
              updatedAt: new Date(),
            })
            .where(eq(batches.id, existingBatch.id))
            .returning({ id: batches.id });

          if (!updated) throw new PurchaseError("Failed to update batch stock");
          batchId = updated.id;
        } else {
          const [created] = await tx
            .insert(batches)
            .values({
              productId: item.productId,
              batchNumber: item.batchNumber,
              expiryDate: item.expiryDate,
              purchaseRate: item.purchaseRate,
              saleRate: item.saleRate,
              mrp: item.mrp,
              location: item.location || null,
              stock: stockQuantity,
            })
            .returning({ id: batches.id });

          if (!created) throw new PurchaseError("Failed to create batch");
          batchId = created.id;
        }

        await tx.insert(purchaseItems).values({
          purchaseId: purchase.id,
          productId: item.productId,
          batchId,
          quantity: item.quantity,
          freeQuantity: item.freeQuantity,
          purchaseRate: item.purchaseRate,
          mrp: item.mrp,
          saleRate: item.saleRate,
          gstRate: product.gstRate,
          taxableAmount: priced.taxableAmount,
          cgstAmount: priced.cgstAmount,
          sgstAmount: priced.sgstAmount,
          igstAmount: priced.igstAmount,
          totalAmount: priced.totalAmount,
        });
      }

      await createAuditLog(tx, {
        userId: actor.id,
        action: "PURCHASE_CREATED",
        entityType: "purchase",
        entityId: purchase.id,
        details: {
          invoiceNumber: purchase.invoiceNumber,
          supplierId: purchase.supplierId,
          totalAmount: totals.totalAmount,
          itemCount: parsedItems.length,
        },
      });

      return purchase;
    });

    revalidatePath("/purchases");
    revalidatePath("/inventory");
    revalidatePath("/products");
    revalidatePath("/");
    revalidatePath("/gst");
    revalidatePath("/reports");

    return { success: true, data: result, totals };
  } catch (error) {
    return { success: false, error: actionError(error) };
  }
}
