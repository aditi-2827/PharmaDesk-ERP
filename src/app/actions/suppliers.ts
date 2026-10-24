"use server";

import { eq, like, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { suppliers } from "@/db/schema";
import { AuthorizationError, requireOwner } from "@/lib/authorization";
import { createAuditLog } from "@/lib/audit";
import { gstinSchema, emailSchema } from "@/lib/validation";

const optionalEmail = z
  .union([z.literal(""), emailSchema])
  .optional()
  .nullable()
  .transform((value) => value || null);

const supplierSchema = z.object({
  name: z.string().trim().min(1, "Supplier name is required").max(200),
  contactPerson: z.string().trim().max(200).optional().nullable().transform((value) => value || null),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\-() ]{6,20}$/, "Enter a valid phone number")
    .optional()
    .or(z.literal("").transform(() => null)),
  email: optionalEmail,
  gstin: gstinSchema.nullable(),
  address: z.string().trim().max(500).optional().nullable().transform((value) => value || null),
  isActive: z.boolean().optional(),
});

export type SupplierInput = z.input<typeof supplierSchema>;

function actionError(error: unknown): string {
  if (error instanceof AuthorizationError) throw error;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid supplier data";
  }

  console.error("Supplier action failed", error);
  return "Unable to save the supplier. Please try again.";
}

export async function getSuppliers() {
  await requireOwner();

  try {
    const allSuppliers = await db.select().from(suppliers).orderBy(suppliers.name);
    return { success: true as const, data: allSuppliers };
  } catch (error) {
    console.error("Failed to fetch suppliers", error);
    return { success: false as const, data: [], error: "Failed to fetch suppliers" };
  }
}

export async function searchSuppliers(query: string) {
  await requireOwner();

  const trimmed = query.trim().slice(0, 100);
  if (!trimmed) return { success: true as const, data: [] };

  try {
    const results = await db
      .select()
      .from(suppliers)
      .where(
        or(
          like(suppliers.name, `%${trimmed}%`),
          like(suppliers.contactPerson, `%${trimmed}%`),
          like(suppliers.phone, `%${trimmed}%`)
        )
      )
      .limit(20);

    return { success: true as const, data: results };
  } catch (error) {
    console.error("Failed to search suppliers", error);
    return { success: false as const, data: [], error: "Failed to search suppliers" };
  }
}

export async function addSupplier(data: SupplierInput) {
  const actor = await requireOwner();

  try {
    const parsed = supplierSchema.parse(data);
    const [supplier] = await db
      .insert(suppliers)
      .values({
        name: parsed.name,
        contactPerson: parsed.contactPerson,
        phone: parsed.phone || null,
        email: parsed.email,
        gstin: parsed.gstin || null,
        address: parsed.address,
        isActive: parsed.isActive ?? true,
      })
      .returning();

    await createAuditLog(db, {
      userId: actor.id,
      action: "SUPPLIER_CREATED",
      entityType: "supplier",
      entityId: supplier.id,
      details: { name: supplier.name, gstin: supplier.gstin },
    });

    revalidatePath("/purchases/suppliers");
    revalidatePath("/purchases/new");
    return { success: true as const, data: supplier };
  } catch (error) {
    return { success: false as const, error: actionError(error) };
  }
}

export async function updateSupplier(id: string, data: Partial<SupplierInput>) {
  const actor = await requireOwner();

  try {
    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) return { success: false as const, error: "Invalid supplier id" };

    const parsed = supplierSchema.partial().parse(data);
    const [supplier] = await db
      .update(suppliers)
      .set({
        ...parsed,
        phone: parsed.phone === undefined ? undefined : parsed.phone || null,
        gstin: parsed.gstin === undefined ? undefined : parsed.gstin || null,
        updatedAt: new Date(),
      })
      .where(eq(suppliers.id, parsedId.data))
      .returning();

    if (!supplier) return { success: false as const, error: "Supplier not found" };

    await createAuditLog(db, {
      userId: actor.id,
      action: "SUPPLIER_UPDATED",
      entityType: "supplier",
      entityId: supplier.id,
      details: { name: supplier.name, isActive: supplier.isActive },
    });

    revalidatePath("/purchases/suppliers");
    revalidatePath("/purchases/new");
    return { success: true as const, data: supplier };
  } catch (error) {
    return { success: false as const, error: actionError(error) };
  }
}
