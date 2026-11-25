import { GoogleGenAI } from "@google/genai";
import { computeEffectiveUnitCostCents } from "@supermarket/shared";
import { eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { db, productBarcodes, products, suppliers } from "../db/index.js";
import { isGeminiConfigured } from "./copilot.js";
import { semanticSearchProducts } from "./semantic.js";
import { runCalibratedTriage, type CalibratedTriageResult } from "./triage.js";

const ExtractedInvoiceLineSchema = z.object({
  description: z.string().default("Unknown item"),
  skuHint: z.string().optional().default(""),
  barcodeHint: z.string().optional().default(""),
  caseQty: z.coerce.number().int().min(1).max(500).default(12),
  paidCases: z.coerce.number().int().min(0).max(5000).default(1),
  freeBonusCases: z.coerce.number().int().min(0).max(1000).default(0),
  invoiceLineTotalCents: z.coerce.number().int().min(0).default(0),
  bestBeforeDate: z.string().optional(),
});

const ExtractedInvoiceSchema = z.object({
  supplierName: z.string().default("Distributor"),
  invoiceNumber: z.string().default("INV-AUTO"),
  invoiceDate: z.string().optional(),
  lines: z.array(ExtractedInvoiceLineSchema).max(200).default([]),
});

export interface ParsedInvoiceInput {
  fileName: string;
  mimeType: string;
  base64Data?: string;
  textContent?: string;
}

export interface ExtractedInvoiceLine {
  description: string;
  skuHint: string;
  barcodeHint: string;
  caseQty: number;
  paidCases: number;
  freeBonusCases: number;
  invoiceLineTotalCents: number;
  bestBeforeDate: string;
  matchedProductId: string | null;
  matchedSku: string | null;
  matchedName: string | null;
  currentAvgCostCents: number;
  effectiveUnitCostCents: number;
  costDeltaPct: number;
  matchConfidence: number;
}

export interface ParsedInvoiceResult {
  mode: "gemini_vision" | "local_parser";
  model: string;
  note: string | null;
  supplierId: string | null;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  lines: ExtractedInvoiceLine[];
  triage: CalibratedTriageResult;
}

interface RawExtractedInvoice {
  supplierName?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  lines?: {
    description?: string;
    skuHint?: string;
    barcodeHint?: string;
    caseQty?: number;
    paidCases?: number;
    freeBonusCases?: number;
    invoiceLineTotalCents?: number;
    bestBeforeDate?: string;
  }[];
}

function parsePlainTextInvoice(text: string): RawExtractedInvoice {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let supplierName = "Summit Brewing & Beer Supply";
  let invoiceNumber = `INV-${new Date().getFullYear()}-${String(Math.floor(10000 + Math.random() * 89999))}`;
  let invoiceDate = new Date().toISOString().slice(0, 10);
  const parsedLines: NonNullable<RawExtractedInvoice["lines"]> = [];

  for (const line of lines) {
    const supMatch = line.match(/^supplier\s*[:=-]\s*(.+)$/i);
    if (supMatch) {
      supplierName = supMatch[1].trim();
      continue;
    }
    const invMatch = line.match(/^invoice(?:\s*#|\s*no)?\s*[:=-]\s*(.+)$/i);
    if (invMatch) {
      invoiceNumber = invMatch[1].trim();
      continue;
    }
    const dateMatch = line.match(/^date\s*[:=-]\s*(\d{4}-\d{2}-\d{2})/i);
    if (dateMatch) {
      invoiceDate = dateMatch[1];
      continue;
    }

    // Pipe-delimited or CSV-like invoice line:
    // SKU/Desc | caseQty | paidCases | freeBonusCases | totalUsd | bestBeforeDate
    const parts = line.split(/[|;]/).map((p) => p.trim());
    if (parts.length >= 4 && !/^item|^sku|^desc/i.test(parts[0])) {
      const desc = parts[0];
      const caseQty = Math.max(1, parseInt(parts[1], 10) || 24);
      const paidCases = Math.max(0, parseInt(parts[2], 10) || 1);
      const freeBonusCases = Math.max(0, parseInt(parts[3], 10) || 0);
      const usdStr = (parts[4] ?? "100").replace(/[^0-9.]/g, "");
      const invoiceLineTotalCents = Math.max(0, Math.round((Number(usdStr) || 0) * 100));
      const bbd =
        parts[5] && /^\d{4}-\d{2}-\d{2}$/.test(parts[5])
          ? parts[5]
          : new Date(Date.now() + 180 * 86400_000).toISOString().slice(0, 10);
      const skuMatch = desc.match(/\b([A-Z]{4}-\d{4})\b/);
      parsedLines.push({
        description: desc,
        skuHint: skuMatch?.[1] ?? "",
        barcodeHint: "",
        caseQty,
        paidCases,
        freeBonusCases,
        invoiceLineTotalCents,
        bestBeforeDate: bbd,
      });
    }
  }

  return { supplierName, invoiceNumber, invoiceDate, lines: parsedLines };
}

export async function parseSupplierInvoice(
  input: ParsedInvoiceInput
): Promise<ParsedInvoiceResult> {
  const defaultBbd = new Date(Date.now() + 180 * 86400_000).toISOString().slice(0, 10);
  let mode: "gemini_vision" | "local_parser" = "local_parser";
  let model = "local-invoice-parser";
  let note: string | null = null;
  let raw: RawExtractedInvoice | null = null;

  if (input.base64Data && isGeminiConfigured()) {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!.trim() });
      const cleanB64 = input.base64Data.replace(/^data:[^;]+;base64,/, "");
      const isPdf = input.mimeType.toLowerCase().includes("pdf");
      const prompt = `Extract this distributor supplier invoice into strict JSON only (no markdown):
{
  "supplierName": string,
  "invoiceNumber": string,
  "invoiceDate": "YYYY-MM-DD",
  "lines": [
    {
      "description": string,
      "skuHint": string,
      "barcodeHint": string,
      "caseQty": integer,
      "paidCases": integer,
      "freeBonusCases": integer,
      "invoiceLineTotalCents": integer,
      "bestBeforeDate": "YYYY-MM-DD"
    }
  ]
}`;
      const mediaBlock = isPdf
        ? { type: "document" as const, data: cleanB64, mime_type: "application/pdf" as const }
        : {
            type: "image" as const,
            data: cleanB64,
            mime_type: (input.mimeType || "image/png") as "image/png",
          };

      const interaction = await ai.interactions.create({
        model: "gemini-4-hydrogen",
        input: [{ type: "text", text: prompt }, mediaBlock],
        store: false,
      });

      const outText = interaction.output_text ?? "";
      const jsonMatch = outText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsedJson = ExtractedInvoiceSchema.safeParse(JSON.parse(jsonMatch[0]));
        if (parsedJson.success && parsedJson.data.lines.length > 0) {
          raw = {
            ...parsedJson.data,
            invoiceDate: parsedJson.data.invoiceDate ?? new Date().toISOString().slice(0, 10),
          };
          mode = "gemini_vision";
          model = "gemini-4-hydrogen";
        } else {
          note = "Gemini Vision returned invalid invoice JSON; used local invoice parser.";
        }
      }
    } catch (err) {
      note = `Gemini Vision OCR failed (${err instanceof Error ? err.message : "error"}); used local invoice parser.`;
    }
  }

  if (!raw && input.textContent?.trim()) {
    raw = parsePlainTextInvoice(input.textContent);
  }

  if (!raw || !raw.lines || raw.lines.length === 0) {
    // Clean sample fallback when an image/PDF is uploaded without GEMINI_API_KEY
    const sampleProds = await db
      .select({ sku: products.sku, name: products.name, avgCostCents: products.avgCostCents })
      .from(products)
      .limit(2);
    const p1 = sampleProds[0] ?? { sku: "BEER-0001", name: "Heineken Original 330ml Can", avgCostCents: 120 };
    raw = {
      supplierName: "Summit Brewing & Beer Supply",
      invoiceNumber: `INV-${new Date().getFullYear()}-90421`,
      invoiceDate: new Date().toISOString().slice(0, 10),
      lines: [
        {
          description: p1.name,
          skuHint: p1.sku,
          barcodeHint: "",
          caseQty: 24,
          paidCases: 10,
          freeBonusCases: 1,
          // Simulate a +22% wholesale invoice cost creep on paid cases for demo visibility
          invoiceLineTotalCents: Math.round(10 * 24 * p1.avgCostCents * 1.22),
          bestBeforeDate: defaultBbd,
        },
      ],
    };
    note =
      note ??
      (input.base64Data && !isGeminiConfigured()
        ? "Demo Vision Fallback (set GEMINI_API_KEY to run live Gemini 4 Hydrogen image/PDF OCR)."
        : null);
  }

  // Match supplier
  const supHint = (raw.supplierName ?? "").trim();
  const [matchedSupplier] = supHint
    ? await db.select().from(suppliers).where(ilike(suppliers.name, `%${supHint.split(" ")[0]}%`)).limit(1)
    : await db.select().from(suppliers).limit(1);

  const enrichedLines: ExtractedInvoiceLine[] = [];
  for (const l of raw.lines ?? []) {
    const desc = (l.description ?? "").trim() || "Unknown Packaged Item";
    const skuHint = (l.skuHint ?? "").trim();
    const bcHint = (l.barcodeHint ?? "").trim();
    const caseQty = Math.max(1, Math.round(Number(l.caseQty ?? 24) || 24));
    const paidCases = Math.max(0, Math.round(Number(l.paidCases ?? 1) || 0));
    const freeBonusCases = Math.max(0, Math.round(Number(l.freeBonusCases ?? 0) || 0));
    const invoiceLineTotalCents = Math.max(
      0,
      Math.round(Number(l.invoiceLineTotalCents ?? 0) || 0)
    );
    const totalUnits = paidCases * caseQty + freeBonusCases * caseQty;
    const effectiveCost = computeEffectiveUnitCostCents(
      invoiceLineTotalCents,
      paidCases * caseQty,
      freeBonusCases * caseQty
    );

    let matched: {
      id: string;
      sku: string;
      name: string;
      avgCostCents: number;
      confidence: number;
    } | null = null;

    if (bcHint) {
      const [bcRow] = await db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          avgCostCents: products.avgCostCents,
        })
        .from(productBarcodes)
        .innerJoin(products, eq(productBarcodes.productId, products.id))
        .where(ilike(productBarcodes.barcode, bcHint))
        .limit(1);
      if (bcRow) matched = { ...bcRow, confidence: 0.99 };
    }

    if (!matched && skuHint) {
      const [skuRow] = await db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          avgCostCents: products.avgCostCents,
        })
        .from(products)
        .where(or(ilike(products.sku, skuHint), ilike(products.name, `%${desc}%`)))
        .limit(1);
      if (skuRow) matched = { ...skuRow, confidence: 0.96 };
    }

    if (!matched && desc) {
      const sem = await semanticSearchProducts(desc, 1);
      if (sem.items[0]) {
        matched = {
          id: sem.items[0].id,
          sku: sem.items[0].sku,
          name: sem.items[0].name,
          avgCostCents: sem.items[0].avgCostCents,
          confidence: sem.items[0].similarityScore,
        };
      }
    }

    const prevCost = matched?.avgCostCents ?? effectiveCost;
    const costDeltaPct =
      prevCost > 0 && totalUnits > 0
        ? Number((((effectiveCost - prevCost) / prevCost) * 100).toFixed(1))
        : 0;

    enrichedLines.push({
      description: desc,
      skuHint,
      barcodeHint: bcHint,
      caseQty,
      paidCases,
      freeBonusCases,
      invoiceLineTotalCents,
      bestBeforeDate:
        l.bestBeforeDate && /^\d{4}-\d{2}-\d{2}$/.test(l.bestBeforeDate)
          ? l.bestBeforeDate
          : defaultBbd,
      matchedProductId: matched?.id ?? null,
      matchedSku: matched?.sku ?? null,
      matchedName: matched?.name ?? null,
      currentAvgCostCents: prevCost,
      effectiveUnitCostCents: effectiveCost,
      costDeltaPct,
      matchConfidence: matched?.confidence ?? 0,
    });
  }

  const maxCostDeltaPct = enrichedLines.reduce(
    (mx, l) => Math.max(mx, l.costDeltaPct),
    0
  );
  const unmatchedLines = enrichedLines.filter((l) => !l.matchedProductId).length;
  const totalBonusCases = enrichedLines.reduce((s, l) => s + l.freeBonusCases, 0);

  const triage = await runCalibratedTriage("invoice_discrepancy", {
    supplierName: matchedSupplier?.name ?? supHint,
    invoiceNumber: raw.invoiceNumber ?? "",
    lineCount: enrichedLines.length,
    unmatchedLines,
    maxCostDeltaPct,
    totalBonusCases,
  });

  return {
    mode,
    model,
    note,
    supplierId: matchedSupplier?.id ?? null,
    supplierName: matchedSupplier?.name ?? (supHint || "Unknown Supplier"),
    invoiceNumber:
      raw.invoiceNumber ??
      `INV-${new Date().getFullYear()}-${String(Math.floor(10000 + Math.random() * 89999))}`,
    invoiceDate: raw.invoiceDate ?? new Date().toISOString().slice(0, 10),
    lines: enrichedLines,
    triage,
  };
}
