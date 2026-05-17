/**
 * Tiny zero-dep CSV serializer. Quotes only when necessary, escapes
 * embedded quotes, normalizes line breaks. Adequate for admin exports;
 * if export volume ever grows enough to need streaming, swap to a
 * Transform stream — but for thousands of rows this is fine.
 */

type Primitive = string | number | boolean | Date | null | undefined;

function escapeCell(v: Primitive): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "boolean") s = v ? "true" : "false";
  else s = String(v);
  // RFC 4180: quote if contains comma, quote, CR, LF
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCsv<T extends Record<string, Primitive>>(
  rows: T[],
  columns: Array<{ key: keyof T; header: string }>
): string {
  const head = columns.map((c) => escapeCell(c.header)).join(",");
  const body = rows
    .map((r) => columns.map((c) => escapeCell(r[c.key])).join(","))
    .join("\r\n");
  return head + "\r\n" + body + (body ? "\r\n" : "");
}

export function csvResponse(filename: string, csv: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/[^a-z0-9._-]/gi, "_")}"`,
      "cache-control": "no-store",
    },
  });
}
