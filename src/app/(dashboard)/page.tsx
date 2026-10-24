import {
  Package,
  TrendingUp,
  AlertTriangle,
  IndianRupee,
  ShoppingCart,
  Clock,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { products, batches, sales, purchases, suppliers } from "@/db/schema";
import { and, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import { requireUserPage } from "@/lib/authorization";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ forbidden?: string }>;
}) {
  const user = await requireUserPage();
  const { forbidden } = await searchParams;
  const isOwner = user.role === "owner";
  const now = new Date();

  const [totalProductsCount, productsWithStock, allBatches] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(products)
      .where(eq(products.isActive, true)),
    db
      .select({
        id: products.id,
        minStockLevel: products.minStockLevel,
        totalStock: sql<number>`COALESCE(SUM(${batches.stock}), 0)`.mapWith(Number),
      })
      .from(products)
      .leftJoin(
        batches,
        and(eq(products.id, batches.productId), gt(batches.expiryDate, now))
      )
      .where(eq(products.isActive, true))
      .groupBy(products.id),
    db.select().from(batches).where(gt(batches.stock, 0)),
  ]);

  const totalProducts = Number(totalProductsCount[0]?.count ?? 0);
  const lowStockItems = productsWithStock.filter(
    (product) => product.totalStock <= product.minStockLevel && product.totalStock > 0
  ).length;
  const outOfStockItems = productsWithStock.filter((product) => product.totalStock === 0).length;

  const ninetyDaysFromNow = new Date();
  ninetyDaysFromNow.setDate(ninetyDaysFromNow.getDate() + 90);
  const expiringSoonBatches = allBatches.filter((batch) => {
    const expiry = new Date(batch.expiryDate);
    return expiry <= ninetyDaysFromNow && expiry > now;
  }).length;
  const expiredBatches = allBatches.filter((batch) => new Date(batch.expiryDate) <= now).length;
  const sellableBatches = allBatches.filter((batch) => new Date(batch.expiryDate) > now);
  const totalInventoryValue = sellableBatches.reduce(
    (sum, batch) => sum + batch.purchaseRate * batch.stock,
    0
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const salesScope = isOwner
    ? and(gte(sales.invoiceDate, today), lt(sales.invoiceDate, tomorrow))
    : and(
        gte(sales.invoiceDate, today),
        lt(sales.invoiceDate, tomorrow),
        eq(sales.createdBy, user.id)
      );

  const todaysSalesQuery = await db
    .select({
      total: sql<number>`COALESCE(SUM(${sales.totalAmount}), 0)`.mapWith(Number),
    })
    .from(sales)
    .where(salesScope);

  const todaysSales = Number(todaysSalesQuery[0]?.total ?? 0);

  const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const monthlySalesQuery = isOwner
    ? await db
        .select({
          total: sql<number>`COALESCE(SUM(${sales.totalAmount}), 0)`.mapWith(Number),
        })
        .from(sales)
        .where(and(gte(sales.invoiceDate, firstDayOfMonth), lt(sales.invoiceDate, nextMonth)))
    : [{ total: 0 }];

  const monthlySales = Number(monthlySalesQuery[0]?.total ?? 0);

  const recentSalesQuery = await db
    .select({
      id: sales.id,
      invoiceNumber: sales.invoiceNumber,
      invoiceDate: sales.invoiceDate,
      paymentMode: sales.paymentMode,
      totalAmount: sales.totalAmount,
    })
    .from(sales)
    .where(isOwner ? undefined : eq(sales.createdBy, user.id))
    .orderBy(desc(sales.invoiceDate))
    .limit(5);

  const recentPurchasesQuery = isOwner
    ? await db
        .select({
          id: purchases.id,
          invoiceNumber: purchases.invoiceNumber,
          purchaseDate: purchases.purchaseDate,
          totalAmount: purchases.totalAmount,
          supplierName: suppliers.name,
        })
        .from(purchases)
        .leftJoin(suppliers, eq(purchases.supplierId, suppliers.id))
        .orderBy(desc(purchases.purchaseDate))
        .limit(5)
    : [];

  const stats = [
    {
      title: isOwner ? "Today's Sales" : "My Sales Today",
      value: `₹${(todaysSales / 100).toFixed(2)}`,
      change: "Live updates",
      changeType: "positive" as const,
      icon: TrendingUp,
      iconBg: "bg-brand-50",
      iconColor: "text-brand-600",
    },
    ...(isOwner
      ? [
          {
            title: "Monthly Revenue",
            value: `₹${(monthlySales / 100).toFixed(2)}`,
            change: "This month",
            changeType: "positive" as const,
            icon: IndianRupee,
            iconBg: "bg-brand-50",
            iconColor: "text-brand-600",
          },
        ]
      : []),
    {
      title: "Total Products",
      value: totalProducts.toString(),
      change: "Active catalogue",
      changeType: "neutral" as const,
      icon: Package,
      iconBg: "bg-gray-50",
      iconColor: "text-gray-500",
    },
    {
      title: "Low Stock Items",
      value: (lowStockItems + outOfStockItems).toString(),
      change: `${outOfStockItems} out of stock`,
      changeType: lowStockItems + outOfStockItems > 0 ? ("negative" as const) : ("positive" as const),
      icon: AlertTriangle,
      iconBg: lowStockItems + outOfStockItems > 0 ? "bg-red-50" : "bg-amber-50",
      iconColor: lowStockItems + outOfStockItems > 0 ? "text-red-600" : "text-amber-600",
    },
    {
      title: "Expiring / Expired",
      value: (expiringSoonBatches + expiredBatches).toString(),
      change: `${expiredBatches} already expired`,
      changeType:
        expiringSoonBatches + expiredBatches > 0 ? ("negative" as const) : ("positive" as const),
      icon: Clock,
      iconBg: "bg-red-50",
      iconColor: "text-red-500",
    },
    ...(isOwner
      ? [
          {
            title: "Sellable Inventory Value",
            value: `₹${(totalInventoryValue / 100).toFixed(2)}`,
            change: "At purchase cost",
            changeType: "neutral" as const,
            icon: ShoppingCart,
            iconBg: "bg-gray-50",
            iconColor: "text-gray-500",
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">
          Welcome back, {user.name}. Here&apos;s your pharmacy overview.
        </p>
      </div>

      {forbidden === "1" && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          You do not have permission to access that page.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {stats.map((stat) => {
          const Icon = stat.icon;

          return (
            <Card key={stat.title}>
              <CardContent className="p-6">
                <div className="flex items-start justify-between">
                  <div className="space-y-3">
                    <p className="text-[13px] text-gray-500 font-medium">{stat.title}</p>
                    <p className="text-[28px] font-semibold text-gray-900 leading-none tracking-tight">
                      {stat.value}
                    </p>
                    <div className="flex items-center gap-1">
                      {stat.changeType === "positive" && (
                        <ArrowUpRight className="w-3.5 h-3.5 text-brand-500" />
                      )}
                      {stat.changeType === "negative" && (
                        <ArrowDownRight className="w-3.5 h-3.5 text-red-500" />
                      )}
                      <span
                        className={`text-xs ${
                          stat.changeType === "positive"
                            ? "text-brand-600"
                            : stat.changeType === "negative"
                              ? "text-red-600"
                              : "text-gray-400"
                        }`}
                      >
                        {stat.change}
                      </span>
                    </div>
                  </div>
                  <div
                    className={`w-10 h-10 rounded-xl ${stat.iconBg} flex items-center justify-center`}
                  >
                    <Icon className={`w-[18px] h-[18px] ${stat.iconColor}`} strokeWidth={1.8} />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-brand-600" strokeWidth={1.8} />
              {isOwner ? "Recent Sales" : "My Recent Sales"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentSalesQuery.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                <ShoppingCart className="w-8 h-8 mb-3 text-gray-200" strokeWidth={1.5} />
                <p className="text-sm font-medium text-gray-500">No sales yet</p>
                <p className="text-xs mt-1 text-gray-400">
                  Sales will appear here once you start billing
                </p>
              </div>
            ) : (
              <div className="space-y-4 mt-2">
                {recentSalesQuery.map((sale) => (
                  <div
                    key={sale.id}
                    className="flex items-center justify-between border-b border-gray-50 pb-4 last:border-0 last:pb-0"
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900">{sale.invoiceNumber}</p>
                      <p className="text-xs text-gray-500">
                        {new Date(sale.invoiceDate).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}{" "}
                        · {sale.paymentMode}
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-gray-900">
                      ₹{(sale.totalAmount / 100).toFixed(2)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {isOwner && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="w-4 h-4 text-gray-500" strokeWidth={1.8} />
                Recent Purchases
              </CardTitle>
            </CardHeader>
            <CardContent>
              {recentPurchasesQuery.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                  <Package className="w-8 h-8 mb-3 text-gray-200" strokeWidth={1.5} />
                  <p className="text-sm font-medium text-gray-500">No purchases yet</p>
                  <p className="text-xs mt-1 text-gray-400">
                    Purchase entries will appear here
                  </p>
                </div>
              ) : (
                <div className="space-y-4 mt-2">
                  {recentPurchasesQuery.map((purchase) => (
                    <div
                      key={purchase.id}
                      className="flex items-center justify-between border-b border-gray-50 pb-4 last:border-0 last:pb-0"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {purchase.invoiceNumber}
                        </p>
                        <p className="text-xs text-gray-500">
                          {new Date(purchase.purchaseDate).toLocaleDateString()} ·{" "}
                          {purchase.supplierName || "Unknown Supplier"}
                        </p>
                      </div>
                      <p className="text-sm font-semibold text-gray-900">
                        ₹{(purchase.totalAmount / 100).toFixed(2)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
