const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function escapeCsvFormula(value: unknown): string {
  const text = stringifyCell(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

export function escapeCsvCell(value: unknown): string {
  const text = escapeCsvFormula(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvCell).join(",")];

  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(","));
  }

  return `\uFEFF${lines.join("\r\n")}`;
}
