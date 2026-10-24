"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Search, Trash2, Receipt, Printer, Loader2, Plus, Box, ShieldAlert } from "lucide-react";
import { searchProductsForBilling, createSale, previewSale } from "@/app/actions/sales";
import type { Sale } from "@/db/schema";
import { computeSaleTotals, type PricedTotals } from "@/lib/pricing";

interface ProductResult {
  id: string;
  name: string;
  genericName: string | null;
  packSize: string | null;
  gstRate: number;
  totalStock: number;
  saleRate: number | null;
  mrp: number | null;
}

interface CartItem extends ProductResult {
  quantity: number;
}

interface PickListItem {
  productId: string;
  productName: string;
  batchNumber: string;
  location: string;
  quantityToPick: number;
  expiryDate: Date;
  saleRate: number;
}

type PaymentMode = "cash" | "card" | "upi" | "credit";

interface CompletedSale {
  sale: Sale;
  totals: PricedTotals;
}

export function BillingClient() {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ProductResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerGstin, setCustomerGstin] = useState("");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("cash");
  const [discountAmount, setDiscountAmount] = useState<number | "">("");
  const [discountType, setDiscountType] = useState<"flat" | "percent">("flat");

  const [isPreviewing, setIsPreviewing] = useState(false);
  const [pickList, setPickList] = useState<PickListItem[]>([]);
  const [previewTotals, setPreviewTotals] = useState<PricedTotals | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [invoiceSuccess, setInvoiceSuccess] = useState<CompletedSale | null>(null);

  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      setIsSearching(true);
      const res = await searchProductsForBilling(searchQuery);
      if (res.success) setSearchResults(res.data);
      setIsSearching(false);
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [searchQuery]);

  const addToCart = (product: ProductResult) => {
    setCart((prev) => {
      const existing = prev.find((p) => p.id === product.id);
      if (existing) {
        if (existing.quantity >= product.totalStock) return prev;
        return prev.map((p) => p.id === product.id ? { ...p, quantity: p.quantity + 1 } : p);
      }
      return [...prev, { ...product, quantity: 1 }];
    });
  };

  const updateQuantity = (id: string, delta: number) => {
    setCart((prev) => prev.map((p) => {
      if (p.id === id) {
        const newQty = Math.max(1, Math.min(p.quantity + delta, p.totalStock));
        return { ...p, quantity: newQty };
      }
      return p;
    }));
  };

  const removeFromCart = (id: string) => {
    setCart((prev) => prev.filter((p) => p.id !== id));
  };

  const calculations = useMemo(() => {
    const gross = cart.reduce(
      (sum, item) => sum + (item.saleRate ?? 0) * item.quantity,
      0
    );
    const discountValue =
      discountType === "percent"
        ? Math.round(gross * (Number(discountAmount) / 100))
        : Math.round(Number(discountAmount) * 100);

    const totals = computeSaleTotals(
      cart.map((item) => ({
        quantity: item.quantity,
        saleRate: item.saleRate ?? 0,
        gstRate: item.gstRate,
      })),
      Math.max(0, discountValue),
      false
    );

    return { ...totals, discountValue: totals.discount, gross };
  }, [cart, discountAmount, discountType]);

  const getDiscountPaise = () => {
    if (discountType === "percent") {
      return Math.round(calculations.gross * (Number(discountAmount) / 100));
    }
    return Math.round(Number(discountAmount) * 100);
  };

  const handlePreviewCheckout = async () => {
    if (cart.length === 0) return;
    setIsPreviewing(true);

    const res = await previewSale({
      customerGstin: customerGstin || undefined,
      discount: getDiscountPaise(),
      items: cart.map((item) => ({
        productId: item.id,
        productName: item.name,
        quantity: item.quantity,
      })),
    });

    setIsPreviewing(false);

    if (res.success) {
      setPickList(res.pickList);
      setPreviewTotals(res.totals);
      setShowConfirmModal(true);
    } else {
      alert("Failed to generate pick-list: " + res.error);
    }
  };

  const handleConfirmCheckout = async () => {
    setIsSubmitting(true);

    const res = await createSale({
      customerName: customerName || null,
      customerPhone: customerPhone || null,
      customerGstin: customerGstin || undefined,
      paymentMode,
      discount: getDiscountPaise(),
      items: cart.map((item) => ({
        productId: item.id,
        productName: item.name,
        quantity: item.quantity,
      })),
    });

    setIsSubmitting(false);

    if (res.success) {
      setShowConfirmModal(false);
      setInvoiceSuccess({ sale: res.sale, totals: res.totals });
      setCart([]);
      setCustomerName("");
      setCustomerPhone("");
      setCustomerGstin("");
      setDiscountAmount("");
      setPreviewTotals(null);
      setPickList([]);
    } else {
      alert("Failed to create sale: " + res.error);
    }
  };

  if (invoiceSuccess) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 animate-fade-in">
        <Card className="border-green-200">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto">
              <Receipt className="w-8 h-8" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Sale Complete!</h2>
            <p className="text-gray-500">
              Invoice {invoiceSuccess.sale.invoiceNumber} · ₹
              {(invoiceSuccess.totals.totalAmount / 100).toFixed(2)}
            </p>

            <div className="flex justify-center gap-4 pt-4">
              <Button
                onClick={async () => {
                  setInvoiceSuccess(null);
                  setIsSearching(true);
                  const res = await searchProductsForBilling("");
                  if (res.success) setSearchResults(res.data);
                  setIsSearching(false);
                }}
                variant="outline"
              >
                New Sale
              </Button>
              <Button asChild className="gap-2">
                <Link href={`/sales/${invoiceSuccess.sale.id}/invoice`} target="_blank">
                  <Printer className="w-4 h-4" /> Print Invoice
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 animate-fade-in pb-20">
        
        {/* COLUMN 1: Search & Add (4 columns) */}
        <div className="xl:col-span-4 h-[calc(100vh-140px)] flex flex-col">
          <Card className="flex-1 flex flex-col overflow-hidden">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Add Products</CardTitle>
              <div className="relative mt-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                <Input 
                  placeholder="Search by product or generic name..." 
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto px-4 pb-4">
              {isSearching ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-brand-600" />
                </div>
              ) : searchResults.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">
                  No in-stock products found.
                </div>
              ) : (
                <div className="space-y-3">
                  {searchResults.map((product) => (
                    <div key={product.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-100 hover:border-brand-200 hover:bg-brand-50/30 transition-colors">
                      <div className="flex-1 min-w-0 pr-4">
                        <p className="font-medium text-gray-900 truncate">{product.name}</p>
                        <p className="text-xs text-gray-500 truncate">{product.genericName || "N/A"}</p>
                        <div className="flex items-center gap-3 mt-1 text-xs">
                          <span className="text-brand-600 font-medium">₹{product.saleRate ? (product.saleRate / 100).toFixed(2) : '-'}</span>
                          <span className="text-gray-400">Stock: {product.totalStock}</span>
                        </div>
                      </div>
                      <Button size="sm" onClick={() => addToCart(product)} disabled={product.totalStock <= 0} className="shrink-0 h-8 w-8 p-0">
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* COLUMN 2: Cart (5 columns) */}
        <div className="xl:col-span-5 h-[calc(100vh-140px)] flex flex-col">
          <Card className="flex-1 flex flex-col overflow-hidden">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Shopping Cart</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto p-0">
              {cart.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-400 p-8">
                  <Receipt className="w-12 h-12 mb-4 text-gray-200" />
                  <p>Your cart is empty.</p>
                  <p className="text-sm">Search and add products from the left.</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0 border-y border-gray-100">
                    <tr>
                      <th className="text-left py-3 px-4 font-medium text-gray-500">Item</th>
                      <th className="text-center py-3 px-4 font-medium text-gray-500 w-32">Qty</th>
                      <th className="text-right py-3 px-4 font-medium text-gray-500">Price</th>
                      <th className="w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cart.map((item) => (
                      <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="py-3 px-4">
                          <p className="font-medium text-gray-900">{item.name}</p>
                          <p className="text-xs text-gray-500">{item.packSize}</p>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center justify-center gap-2">
                            <button 
                              onClick={() => updateQuantity(item.id, -1)}
                              className="w-6 h-6 rounded border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-100"
                            >-</button>
                            <span className="w-8 text-center font-medium">{item.quantity}</span>
                            <button 
                              onClick={() => updateQuantity(item.id, 1)}
                              className="w-6 h-6 rounded border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-100"
                            >+</button>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <p className="font-medium text-gray-900">₹{item.saleRate ? ((item.saleRate * item.quantity) / 100).toFixed(2) : '0.00'}</p>
                          {item.gstRate > 0 && <p className="text-[10px] text-gray-400">+{item.gstRate}% GST</p>}
                        </td>
                        <td className="py-3 pr-4">
                          <button 
                            onClick={() => removeFromCart(item.id)}
                            className="text-red-400 hover:text-red-600 transition-colors p-1"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>

        {/* COLUMN 3: Checkout Summary (3 columns) */}
        <div className="xl:col-span-3 space-y-6">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="customerName" className="text-xs">Name (Optional)</Label>
                <Input 
                  id="customerName" 
                  placeholder="John Doe" 
                  className="h-9"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customerPhone" className="text-xs">Phone (Optional)</Label>
                <Input 
                  id="customerPhone" 
                  placeholder="9876543210" 
                  className="h-9"
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customerGstin" className="text-xs">GSTIN (Optional)</Label>
                <Input
                  id="customerGstin"
                  placeholder="22AAAAA0000A1Z5"
                  className="h-9 font-mono uppercase"
                  maxLength={15}
                  value={customerGstin}
                  onChange={(e) => setCustomerGstin(e.target.value.toUpperCase())}
                />
                <p className="text-[10px] text-gray-400">
                  Used to determine CGST/SGST vs IGST automatically.
                </p>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-gray-50/50 border-brand-100">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Payment</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between text-gray-500">
                  <span>Subtotal</span>
                  <span>₹{(calculations.subtotal / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-gray-500">
                  <span>CGST</span>
                  <span>₹{(calculations.cgst / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-gray-500">
                  <span>SGST</span>
                  <span>₹{(calculations.sgst / 100).toFixed(2)}</span>
                </div>
                {calculations.igst > 0 && (
                  <div className="flex justify-between text-gray-500">
                    <span>IGST</span>
                    <span>₹{(calculations.igst / 100).toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between items-center pt-2">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-900 font-medium">Discount</span>
                    <select 
                      className="text-xs border-gray-200 rounded px-1 py-0.5 text-gray-500 bg-gray-50 outline-none"
                      value={discountType}
                      onChange={(e) => setDiscountType(e.target.value as "flat" | "percent")}
                    >
                      <option value="flat">₹</option>
                      <option value="percent">%</option>
                    </select>
                  </div>
                  <Input 
                    type="number" 
                    min="0"
                    placeholder="0"
                    className="w-24 h-8 text-right"
                    value={discountAmount}
                    onChange={(e) => setDiscountAmount(e.target.value ? Number(e.target.value) : "")}
                  />
                </div>
              </div>
              <div className="pt-4 border-t border-gray-200">
                <div className="flex justify-between items-center mb-4">
                  <span className="font-semibold text-gray-900">Total</span>
                  <span className="text-2xl font-bold text-brand-600">₹{(calculations.totalAmount / 100).toFixed(2)}</span>
                </div>
                
                <div className="space-y-2 mb-6">
                  <div className="grid grid-cols-2 gap-2">
                    {['cash', 'upi', 'card', 'credit'].map((mode) => (
                      <Button 
                        key={mode}
                        type="button"
                        variant={paymentMode === mode ? 'default' : 'outline'}
                        className="capitalize h-8 text-xs"
                        onClick={() => setPaymentMode(mode as PaymentMode)}
                      >
                        {mode}
                      </Button>
                    ))}
                  </div>
                </div>
                
                <Button 
                  className="w-full h-12 text-base font-medium" 
                  disabled={cart.length === 0 || isPreviewing}
                  onClick={handlePreviewCheckout}
                >
                  {isPreviewing ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Checkout'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in backdrop-blur-sm">
          <Card className="w-full max-w-2xl mx-4 shadow-xl border-brand-200">
            <CardHeader className="border-b border-gray-100 bg-gray-50/50">
              <CardTitle className="flex items-center gap-2 text-xl">
                <Box className="w-6 h-6 text-brand-600" />
                Pharmacist Pick-List
              </CardTitle>
              <p className="text-sm text-gray-500">Please pick the following exact batches from the inventory to fulfill this FEFO order.</p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-[400px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="text-left py-3 px-4 font-medium text-gray-500">Product</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-500">Batch #</th>
                      <th className="text-left py-3 px-4 font-medium text-gray-500">Location</th>
                      <th className="text-right py-3 px-4 font-medium text-gray-500">Qty to Pick</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pickList.map((pick, i) => (
                      <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="py-3 px-4 font-medium text-gray-900">{pick.productName}</td>
                        <td className="py-3 px-4">
                          <span className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-gray-100 text-gray-700">
                            {pick.batchNumber}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-brand-700">{pick.location}</td>
                        <td className="py-3 px-4 text-right font-bold text-brand-600">{pick.quantityToPick}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {previewTotals && (
                <div className="border-t border-gray-100 px-4 py-3 bg-white text-sm space-y-1">
                  <div className="flex justify-between text-gray-500">
                    <span>Taxable value</span>
                    <span>₹{(previewTotals.subtotal / 100).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-gray-500">
                    <span>Discount</span>
                    <span>₹{(previewTotals.discount / 100).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between font-semibold text-gray-900">
                    <span>Invoice total</span>
                    <span>₹{(previewTotals.totalAmount / 100).toFixed(2)}</span>
                  </div>
                </div>
              )}
              <div className="p-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowConfirmModal(false);
                    setPreviewTotals(null);
                  }}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button onClick={handleConfirmCheckout} disabled={isSubmitting} className="gap-2">
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldAlert className="w-4 h-4" />}
                  Confirm & Complete Sale
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
