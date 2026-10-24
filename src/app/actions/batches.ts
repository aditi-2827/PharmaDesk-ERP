"use server";

import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { batches, products } from "@/db/schema";
import { AuthorizationError, requireOwner, requireUser } from "@/lib/authorization";
import { createAuditLog } from "@/lib/audit";

const batchSchema = z.object({
  productId: z.string().uuid(),
  batchNumber: z.string().trim().min(1, "Batch number is required").max(100),
  expiryDate: z.coerce.date().refine(
    (date) => date.getTime() > new Date().setHours(0, 0, 0, 0),
    "Expiry date must be in the future"
  ),
  mrp: z.coerce.number().min(0).max(1_000_000),
  purchaseRate: z.coerce.number().min(0).max(1_000_000),
  saleRate: z.coerce.number().min(0).max(1_000_000),
  stock: z.coerce.number().int().min(0).max(1_000_000),
  location: z.string().trim().max(100).optional(),
});

export type BatchInput = z.input<typeof batchSchema>;

function toPaise(value: number): number {
  return Math.round(value * 100);
}

function actionError(error: unknown): string {
  if (error instanceof AuthorizationError) throw error;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid batch data";
  }

  console.error("Batch action failed", error);
  return "Unable to save the batch. Please try again.";
}

export async function addBatch(data: BatchInput) {
  const actor = await requireOwner();

  try {
    const parsed = batchSchema.parse(data);

    if (parsed.saleRate > parsed.mrp) {
      return { error: "Sale rate cannot exceed MRP" };
    }

    const product = await db.query.products.findFirst({
      where: and(eq(products.id, parsed.productId), eq(products.isActive, true)),
      columns: { id: true, name: true },
    });

    if (!product) return { error: "Product not found or inactive" };

    const existing = await db.query.batches.findFirst({
      where: and(
        eq(batches.productId, parsed.productId),
        eq(batches.batchNumber, parsed.batchNumber),
        eq(batches.expiryDate, parsed.expiryDate)
      ),
      columns: { id: true },
    });

    if (existing) {
      return { error: "This batch already exists. Use a purchase invoice or adjust its stock." };
    }

    const [batch] = await db
      .insert(batches)
      .values({
        productId: parsed.productId,
        batchNumber: parsed.batchNumber,
        expiryDate: parsed.expiryDate,
        mrp: toPaise(parsed.mrp),
        purchaseRate: toPaise(parsed.purchaseRate),
        saleRate: toPaise(parsed.saleRate),
        stock: parsed.stock,
        location: parsed.location || null,
      })
      .returning();

    await createAuditLog(db, {
      userId: actor.id,
      action: "BATCH_CREATED",
      entityType: "batch",
      entityId: batch.id,
      details: {
        productId: batch.productId,
        productName: product.name,
        batchNumber: batch.batchNumber,
        stock: batch.stock,
        expiryDate: batch.expiryDate,
      },
    });

    revalidatePath("/inventory");
    revalidatePath(`/products/${parsed.productId}`);
    return { success: true as const, batch };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function updateBatchStock(
  id: string,
  newStock: number,
  productId: string,
  reason?: string
) {
  const actor = await requireOwner();

  try {
    const parsedId = z.string().uuid().safeParse(id);
    const parsedProductId = z.string().uuid().safeParse(productId);
    const parsedStock = z.coerce.number().int().min(0).max(1_000_000).safeParse(newStock);
    const parsedReason = z
      .string()
      .trim()
      .max(300)
      .optional()
      .transform((value) => value || "Manual stock adjustment")
      .parse(reason);

    if (!parsedId.success || !parsedProductId.success) return { error: "Invalid batch" };
    if (!parsedStock.success) return { error: "Stock must be a non-negative whole number" };

    const batch = await db.query.batches.findFirst({
      where: and(eq(batches.id, parsedId.data), eq(batches.productId, parsedProductId.data)),
      columns: { id: true, stock: true, batchNumber: true },
    });

    if (!batch) return { error: "Batch not found" };

    await db
      .update(batches)
      .set({ stock: parsedStock.data, updatedAt: new Date() })
      .where(eq(batches.id, batch.id));

    await createAuditLog(db, {
      userId: actor.id,
      action: "STOCK_ADJUSTED",
      entityType: "batch",
      entityId: batch.id,
      details: {
        batchNumber: batch.batchNumber,
        previousStock: batch.stock,
        newStock: parsedStock.data,
        delta: parsedStock.data - batch.stock,
        reason: parsedReason,
      },
    });

    revalidatePath("/inventory");
    revalidatePath(`/products/${parsedProductId.data}`);
    revalidatePath("/expiry");
    return { success: true as const };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function getBatchesForProduct(productId: string) {
  await requireUser();

  const parsedId = z.string().uuid().safeParse(productId);
  if (!parsedId.success) return { data: [], error: "Invalid product id" };

  try {
    const data = await db
      .select()
      .from(batches)
      .where(eq(batches.productId, parsedId.data))
      .orderBy(asc(batches.expiryDate));

    return { data };
  } catch (error) {
    console.error("Failed to fetch batches", error);
    return { error: "Failed to fetch batches", data: [] };
  }
}
