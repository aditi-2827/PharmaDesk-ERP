export type TaxBreakup = {
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
};

export type PricedLine = TaxBreakup & {
  grossAmount: number;
  discountAmount: number;
  gstRate: number;
};

export type PricedTotals = {
  subtotal: number;
  discount: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalAmount: number;
  lines: PricedLine[];
};

export type TaxableLineInput = {
  quantity: number;
  rate: number;
  gstRate: number;
};

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function toInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function splitInclusiveTax(grossAmount: number, gstRate: number, interState: boolean): TaxBreakup {
  const gross = toInteger(grossAmount);
  const rate = Math.min(100, Math.max(0, gstRate));
  const taxableAmount = Math.round((gross * 100) / (100 + rate));
  const taxAmount = gross - taxableAmount;

  if (interState) {
    return {
      taxableAmount,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: taxAmount,
      totalAmount: gross,
    };
  }

  const cgstAmount = Math.floor(taxAmount / 2);
  return {
    taxableAmount,
    cgstAmount,
    sgstAmount: taxAmount - cgstAmount,
    igstAmount: 0,
    totalAmount: gross,
  };
}

export function allocateDiscount(amounts: number[], discountAmount: number): number[] {
  if (amounts.length === 0) return [];

  const gross = amounts.reduce((sum, amount) => sum + toInteger(amount), 0);
  const appliedDiscount = Math.min(gross, toInteger(discountAmount));
  if (gross === 0 || appliedDiscount === 0) return amounts.map(() => 0);

  let allocated = 0;
  return amounts.map((amount, index) => {
    if (index === amounts.length - 1) return appliedDiscount - allocated;

    const share = Math.floor((appliedDiscount * toInteger(amount)) / gross);
    allocated += share;
    return share;
  });
}

function computeTotals(lines: TaxableLineInput[], discountAmount: number, interState: boolean): PricedTotals {
  const grossAmounts = lines.map((line) => toInteger(line.rate) * toInteger(line.quantity));
  const gross = grossAmounts.reduce((sum, amount) => sum + amount, 0);
  const appliedDiscount = Math.min(gross, toInteger(discountAmount));
  const discounts = allocateDiscount(grossAmounts, appliedDiscount);

  const pricedLines = lines.map((line, index) => {
    const grossAmount = grossAmounts[index] ?? 0;
    const lineDiscount = discounts[index] ?? 0;
    const tax = splitInclusiveTax(grossAmount - lineDiscount, line.gstRate, interState);

    return {
      ...tax,
      grossAmount,
      discountAmount: lineDiscount,
      gstRate: line.gstRate,
    };
  });

  return {
    subtotal: pricedLines.reduce((sum, line) => sum + line.taxableAmount, 0),
    discount: appliedDiscount,
    cgst: pricedLines.reduce((sum, line) => sum + line.cgstAmount, 0),
    sgst: pricedLines.reduce((sum, line) => sum + line.sgstAmount, 0),
    igst: pricedLines.reduce((sum, line) => sum + line.igstAmount, 0),
    totalAmount: gross - appliedDiscount,
    lines: pricedLines,
  };
}

export function computeSaleTotals(
  lines: Array<{ quantity: number; saleRate: number; gstRate: number }>,
  discountAmount: number,
  interState: boolean
): PricedTotals {
  return computeTotals(
    lines.map((line) => ({ quantity: line.quantity, rate: line.saleRate, gstRate: line.gstRate })),
    discountAmount,
    interState
  );
}

export function computePurchaseTotals(
  lines: Array<{ quantity: number; purchaseRate: number; gstRate: number }>,
  discountAmount: number,
  interState: boolean
): PricedTotals {
  return computeTotals(
    lines.map((line) => ({ quantity: line.quantity, rate: line.purchaseRate, gstRate: line.gstRate })),
    discountAmount,
    interState
  );
}

export function isValidGstin(value: string | null | undefined): boolean {
  return !!value && GSTIN_PATTERN.test(value.trim().toUpperCase());
}

export function isInterStateTransaction(
  storeGstin: string | null | undefined,
  partyGstin: string | null | undefined,
  fallback: boolean
): boolean {
  const store = (storeGstin || "").trim().toUpperCase();
  const party = (partyGstin || "").trim().toUpperCase();

  if (isValidGstin(store) && isValidGstin(party)) {
    return store.slice(0, 2) !== party.slice(0, 2);
  }

  return fallback;
}
