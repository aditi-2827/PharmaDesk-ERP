"use server";

import { eq, ilike, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { products } from "@/db/schema";
import { GST_RATES } from "@/lib/constants";
import { AuthorizationError, requireOwner, requireUser } from "@/lib/authorization";
import { createAuditLog } from "@/lib/audit";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null));

const productSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  genericName: optionalText(200),
  manufacturer: optionalText(200),
  category: z.string().trim().min(1, "Category is required").max(100),
  hsnCode: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, "HSN code must be 4 to 8 digits")
    .optional()
    .nullable()
    .or(z.literal("").transform(() => null)),
  gstRate: z.coerce
    .number()
    .int()
    .refine((value) => GST_RATES.includes(value as (typeof GST_RATES)[number]), "Invalid GST rate"),
  packSize: optionalText(100),
  minStockLevel: z.coerce.number().int().min(0).max(1_000_000),
});

export type ProductInput = z.infer<typeof productSchema>;

function actionError(error: unknown): string {
  if (error instanceof AuthorizationError) throw error;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid product data";
  }

  console.error("Product action failed", error);
  return "Unable to save the product. Please try again.";
}

export async function addProduct(data: ProductInput) {
  const actor = await requireOwner();

  try {
    const parsed = productSchema.parse(data);
    const [product] = await db
      .insert(products)
      .values({
        name: parsed.name,
        genericName: parsed.genericName,
        manufacturer: parsed.manufacturer,
        category: parsed.category,
        hsnCode: parsed.hsnCode || null,
        gstRate: parsed.gstRate,
        packSize: parsed.packSize,
        minStockLevel: parsed.minStockLevel,
      })
      .returning();

    await createAuditLog(db, {
      userId: actor.id,
      action: "PRODUCT_CREATED",
      entityType: "product",
      entityId: product.id,
      details: { name: product.name },
    });

    revalidatePath("/products");
    return { success: true as const, product };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function updateProduct(id: string, data: ProductInput) {
  const actor = await requireOwner();

  try {
    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) return { error: "Invalid product id" };

    const parsed = productSchema.parse(data);
    const [product] = await db
      .update(products)
      .set({
        name: parsed.name,
        genericName: parsed.genericName,
        manufacturer: parsed.manufacturer,
        category: parsed.category,
        hsnCode: parsed.hsnCode || null,
        gstRate: parsed.gstRate,
        packSize: parsed.packSize,
        minStockLevel: parsed.minStockLevel,
        updatedAt: new Date(),
      })
      .where(eq(products.id, parsedId.data))
      .returning();

    if (!product) return { error: "Product not found" };

    await createAuditLog(db, {
      userId: actor.id,
      action: "PRODUCT_UPDATED",
      entityType: "product",
      entityId: product.id,
      details: { name: product.name, gstRate: product.gstRate },
    });

    revalidatePath("/products");
    revalidatePath(`/products/${product.id}`);
    return { success: true as const };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function toggleProductStatus(id: string, isActive: boolean) {
  const actor = await requireOwner();

  try {
    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) return { error: "Invalid product id" };
    if (typeof isActive !== "boolean") return { error: "Invalid status" };

    const [product] = await db
      .update(products)
      .set({ isActive, updatedAt: new Date() })
      .where(eq(products.id, parsedId.data))
      .returning({ id: products.id, name: products.name });

    if (!product) return { error: "Product not found" };

    await createAuditLog(db, {
      userId: actor.id,
      action: isActive ? "PRODUCT_ENABLED" : "PRODUCT_DISABLED",
      entityType: "product",
      entityId: product.id,
      details: { name: product.name },
    });

    revalidatePath("/products");
    revalidatePath(`/products/${product.id}`);
    return { success: true as const };
  } catch (error) {
    return { error: actionError(error) };
  }
}

export async function searchProducts(query: string) {
  await requireUser();

  const trimmed = query.trim().slice(0, 100);
  if (trimmed.length < 2) return { data: [] };

  try {
    const results = await db
      .select()
      .from(products)
      .where(
        or(
          ilike(products.name, `%${trimmed}%`),
          ilike(products.genericName, `%${trimmed}%`)
        )
      )
      .limit(10);

    return { data: results };
  } catch (error) {
    console.error("Product search failed", error);
    return { error: "Search failed", data: [] };
  }
}
