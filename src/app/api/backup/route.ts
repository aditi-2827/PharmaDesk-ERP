import { NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  batches,
  products,
  purchaseItems,
  purchases,
  saleItems,
  sales,
  storeSettings,
  suppliers,
  users,
} from "@/db/schema";
import { getCurrentUser } from "@/lib/authorization";
import { createAuditLog } from "@/lib/audit";
import { toCsv } from "@/lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPORT_TYPES = [
  "products",
  "batches",
  "sales",
  "purchases",
  "customers",
  "suppliers",
  "gst-sales",
  "gst-purchases",
  "full",
] as const;

type ExportType = (typeof EXPORT_TYPES)[number];

function filenameFor(type: ExportType): string {
  const date = new Date().toISOString().split("T")[0];
  return `pharmacare_${type.replace("-", "_")}_${date}.${type === "full" ? "json" : "csv"}`;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (user.role !== "owner") {
    return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") as ExportType | null;

    if (!type || !EXPORT_TYPES.includes(type)) {
      return NextResponse.json({ error: "Invalid export type" }, { status: 400 });
    }

    await createAuditLog(db, {
      userId: user.id,
      action: "DATA_EXPORTED",
      entityType: "export",
      entityId: type,
      details: { type },
    });

    if (type === "full") {
      const [
        productRows,
        batchRows,
        saleRows,
        saleItemRows,
        purchaseRows,
        purchaseItemRows,
        supplierRows,
        settingsRows,
        userRows,
      ] = await Promise.all([
        db.select().from(products),
        db.select().from(batches),
        db.select().from(sales),
        db.select().from(saleItems),
        db.select().from(purchases),
        db.select().from(purchaseItems),
        db.select().from(suppliers),
        db.select().from(storeSettings),
        db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: users.role,
            isActive: users.isActive,
            lastLoginAt: users.lastLoginAt,
            createdAt: users.createdAt,
          })
          .from(users),
      ]);

      const payload = {
        exportedAt: new Date().toISOString(),
        schemaVersion: 2,
        notice: "Password hashes are intentionally excluded. Reset passwords after a full restore.",
        products: productRows,
        batches: batchRows,
        sales: saleRows,
        saleItems: saleItemRows,
        purchases: purchaseRows,
        purchaseItems: purchaseItemRows,
        suppliers: supplierRows,
        storeSettings: settingsRows,
        users: userRows,
      };

      return new NextResponse(JSON.stringify(payload, null, 2), {
        headers: {
          "Content-Disposition": `attachment; filename="${filenameFor(type)}"`,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    let csv = "";

    if (type === "products") {
      const rows = await db.select().from(products).orderBy(products.name);
      csv = toCsv(
        [
          "id",
          "name",
          "generic_name",
          "manufacturer",
          "category",
          "hsn_code",
          "gst_rate",
          "pack_size",
          "min_stock_level",
          "is_active",
          "created_at",
          "updated_at",
        ],
        rows.map((row) => [
          row.id,
          row.name,
          row.genericName,
          row.manufacturer,
          row.category,
          row.hsnCode,
          row.gstRate,
          row.packSize,
          row.minStockLevel,
          row.isActive,
          row.createdAt,
          row.updatedAt,
        ])
      );
    } else if (type === "batches") {
      const rows = await db
        .select({
          id: batches.id,
          productName: products.name,
          batchNumber: batches.batchNumber,
          expiryDate: batches.expiryDate,
          mrp: batches.mrp,
          purchaseRate: batches.purchaseRate,
          saleRate: batches.saleRate,
          stock: batches.stock,
          location: batches.location,
          updatedAt: batches.updatedAt,
        })
        .from(batches)
        .innerJoin(products, eq(batches.productId, products.id))
        .orderBy(batches.expiryDate);

      csv = toCsv(
        [
          "id",
          "product_name",
          "batch_number",
          "expiry_date",
          "mrp_paise",
          "purchase_rate_paise",
          "sale_rate_paise",
          "stock",
          "location",
          "updated_at",
        ],
        rows.map((row) => [
          row.id,
          row.productName,
          row.batchNumber,
          row.expiryDate,
          row.mrp,
          row.purchaseRate,
          row.saleRate,
          row.stock,
          row.location,
          row.updatedAt,
        ])
      );
    } else if (type === "sales" || type === "gst-sales") {
      const rows = await db.select().from(sales).orderBy(desc(sales.invoiceDate));

      csv = toCsv(
        [
          "invoice_number",
          "invoice_date",
          "customer_name",
          "customer_phone",
          "customer_gstin",
          "payment_mode",
          "subtotal_paise",
          "discount_paise",
          "cgst_paise",
          "sgst_paise",
          "igst_paise",
          "total_amount_paise",
        ],
        rows.map((row) => [
          row.invoiceNumber,
          row.invoiceDate,
          row.customerName,
          row.customerPhone,
          row.customerGstin,
          row.paymentMode,
          row.subtotal,
          row.discount,
          row.cgst,
          row.sgst,
          row.igst,
          row.totalAmount,
        ])
      );
    } else if (type === "purchases" || type === "gst-purchases") {
      const rows = await db
        .select({
          invoiceNumber: purchases.invoiceNumber,
          purchaseDate: purchases.purchaseDate,
          supplierName: suppliers.name,
          supplierGstin: suppliers.gstin,
          paymentStatus: purchases.paymentStatus,
          subtotal: purchases.subtotal,
          discount: purchases.discount,
          cgst: purchases.cgst,
          sgst: purchases.sgst,
          igst: purchases.igst,
          totalAmount: purchases.totalAmount,
          notes: purchases.notes,
        })
        .from(purchases)
        .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
        .orderBy(desc(purchases.purchaseDate));

      csv = toCsv(
        [
          "invoice_number",
          "purchase_date",
          "supplier_name",
          "supplier_gstin",
          "payment_status",
          "subtotal_paise",
          "discount_paise",
          "cgst_paise",
          "sgst_paise",
          "igst_paise",
          "total_amount_paise",
          "notes",
        ],
        rows.map((row) => [
          row.invoiceNumber,
          row.purchaseDate,
          row.supplierName,
          row.supplierGstin,
          row.paymentStatus,
          row.subtotal,
          row.discount,
          row.cgst,
          row.sgst,
          row.igst,
          row.totalAmount,
          row.notes,
        ])
      );
    } else if (type === "suppliers") {
      const rows = await db.select().from(suppliers).orderBy(suppliers.name);
      csv = toCsv(
        [
          "name",
          "contact_person",
          "phone",
          "email",
          "gstin",
          "address",
          "is_active",
          "created_at",
        ],
        rows.map((row) => [
          row.name,
          row.contactPerson,
          row.phone,
          row.email,
          row.gstin,
          row.address,
          row.isActive,
          row.createdAt,
        ])
      );
    } else if (type === "customers") {
      const rows = await db
        .select({
          customerPhone: sales.customerPhone,
          customerName: sql<string>`MAX(${sales.customerName})`,
          totalSpent: sql<number>`SUM(${sales.totalAmount})`.mapWith(Number),
          visitCount: sql<number>`COUNT(${sales.id})`.mapWith(Number),
          lastVisit: sql<string>`MAX(${sales.invoiceDate})`,
        })
        .from(sales)
        .where(sql`${sales.customerPhone} IS NOT NULL AND ${sales.customerPhone} <> ''`)
        .groupBy(sales.customerPhone)
        .orderBy(desc(sql`SUM(${sales.totalAmount})`));

      csv = toCsv(
        ["customer_phone", "customer_name", "visit_count", "total_spent_paise", "last_visit"],
        rows.map((row) => [
          row.customerPhone,
          row.customerName,
          row.visitCount,
          row.totalSpent,
          row.lastVisit,
        ])
      );
    }

    return new NextResponse(csv, {
      headers: {
        "Content-Disposition": `attachment; filename="${filenameFor(type)}"`,
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Backup export failed", error);
    return NextResponse.json({ error: "Failed to create backup" }, { status: 500 });
  }
}
