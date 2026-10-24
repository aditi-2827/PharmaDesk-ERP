import { requireUserPage } from "@/lib/authorization";
import { db } from "@/db";
import { products, batches } from "@/db/schema";
import { ProductsClient } from "./client-page";
import { eq, sql } from "drizzle-orm";

export const metadata = {
  title: "Products Master - PharmaDesk ERP",
};

export default async function ProductsPage() {
  const user = await requireUserPage();

  const productsWithStock = await db
    .select({
      id: products.id,
      name: products.name,
      genericName: products.genericName,
      manufacturer: products.manufacturer,
      category: products.category,
      hsnCode: products.hsnCode,
      gstRate: products.gstRate,
      packSize: products.packSize,
      minStockLevel: products.minStockLevel,
      isActive: products.isActive,
      totalStock: sql<number>`COALESCE(SUM(${batches.stock}), 0)`.mapWith(Number),
    })
    .from(products)
    .leftJoin(batches, eq(products.id, batches.productId))
    .groupBy(products.id)
    .orderBy(products.name);

  return <ProductsClient initialProducts={productsWithStock} canManage={user.role === "owner"} />;
}

