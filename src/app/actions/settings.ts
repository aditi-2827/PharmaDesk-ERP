"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { storeSettings } from "@/db/schema";
import { AuthorizationError, requireOwner } from "@/lib/authorization";
import { createAuditLog } from "@/lib/audit";
import { sanitizeInvoicePrefix } from "@/lib/invoice-number";
import { emailSchema, gstinSchema } from "@/lib/validation";

const settingsSchema = z.object({
  name: z.string().trim().min(1, "Store name is required").max(200),
  gstin: gstinSchema.nullable(),
  drugLicenseNo: z.string().trim().max(100).optional().nullable().transform((value) => value || null),
  address: z.string().trim().max(500).optional().nullable().transform((value) => value || null),
  city: z.string().trim().max(100).optional().nullable().transform((value) => value || null),
  state: z.string().trim().max(100).optional().nullable().transform((value) => value || null),
  pincode: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, "Pincode must be 6 digits")
    .optional()
    .or(z.literal("").transform(() => null)),
  phone: z.string().trim().max(20).optional().nullable().transform((value) => value || null),
  email: z
    .union([z.literal(""), emailSchema])
    .optional()
    .nullable()
    .transform((value) => value || null),
  logoUrl: z
    .string()
    .trim()
    .url("Logo URL must be a valid URL")
    .max(500)
    .optional()
    .or(z.literal("").transform(() => null)),
  invoicePrefix: z.string().trim().max(16).transform((value) => sanitizeInvoicePrefix(value)),
  isInterStateDefault: z.boolean().optional().default(false),
  inventoryTrackingMode: z.enum(["pack", "unit"]),
});

export type StoreSettingsInput = z.input<typeof settingsSchema>;

function actionError(error: unknown): string {
  if (error instanceof AuthorizationError) throw error;
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Invalid settings";
  }

  console.error("Settings action failed", error);
  return "Unable to update store settings. Please try again.";
}

export async function updateStoreSettings(data: StoreSettingsInput) {
  const actor = await requireOwner();

  try {
    const parsed = settingsSchema.parse(data);

    const [settings] = await db
      .insert(storeSettings)
      .values({
        id: 1,
        name: parsed.name,
        gstin: parsed.gstin || null,
        drugLicenseNo: parsed.drugLicenseNo,
        address: parsed.address,
        city: parsed.city,
        state: parsed.state,
        pincode: parsed.pincode,
        phone: parsed.phone,
        email: parsed.email,
        logoUrl: parsed.logoUrl,
        invoicePrefix: parsed.invoicePrefix,
        isInterStateDefault: parsed.isInterStateDefault,
        inventoryTrackingMode: parsed.inventoryTrackingMode,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: storeSettings.id,
        set: {
          name: parsed.name,
          gstin: parsed.gstin || null,
          drugLicenseNo: parsed.drugLicenseNo,
          address: parsed.address,
          city: parsed.city,
          state: parsed.state,
          pincode: parsed.pincode,
          phone: parsed.phone,
          email: parsed.email,
          logoUrl: parsed.logoUrl,
          invoicePrefix: parsed.invoicePrefix,
          isInterStateDefault: parsed.isInterStateDefault,
          inventoryTrackingMode: parsed.inventoryTrackingMode,
          updatedAt: new Date(),
        },
      })
      .returning();

    await createAuditLog(db, {
      userId: actor.id,
      action: "STORE_SETTINGS_UPDATED",
      entityType: "store_settings",
      entityId: String(settings.id),
      details: {
        name: settings.name,
        gstin: settings.gstin,
        invoicePrefix: settings.invoicePrefix,
        isInterStateDefault: settings.isInterStateDefault,
      },
    });

    revalidatePath("/settings");
    revalidatePath("/billing");
    revalidatePath("/purchases");
    return { success: true as const, data: settings };
  } catch (error) {
    return { success: false as const, error: actionError(error) };
  }
}
