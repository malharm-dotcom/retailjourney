// UcApiOrderSource — the day-1 OrderSource implementation (PRD §8a).
//
// Discovery uses the UC export-job pattern (proven in the existing n8n flows):
// create an export (exportJobTypeName from env, default "4mclothingllp Sale
// Orders") over a date range, poll the jobCode, download the CSV, and pull SO
// codes out of it. Detail then comes from saleorder/get per order, plus the
// shipping-manifest API for box/weight when a manifest code is present.

import { istMidnightMs } from "../ist";
import { FACILITIES } from "../types";
import { ucDownload, ucPost } from "./uc-client";
import { mapSaleOrder, type UcSaleOrderDTO } from "./uc-map";
import type { OrderSource, UcOrderUpdate } from "./types";

const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 36; // ~3 minutes

function exportJobTypeName(): string {
  return process.env.UC_EXPORT_JOB_TYPE ?? "4mclothingllp Sale Orders";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Minimal CSV parsing (quoted fields, embedded commas/newlines).

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/** Locate a column by fuzzy header match; throws listing headers so a first
 *  real payload immediately tells us what to adjust (lands in SyncRun.errors). */
export function findColumn(headers: string[], candidates: string[]): number {
  const norm = headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  for (const c of candidates) {
    const target = c.toLowerCase().replace(/[^a-z0-9]/g, "");
    const idx = norm.findIndex((h) => h === target || h.includes(target));
    if (idx >= 0) return idx;
  }
  throw new Error(`CSV column not found (tried ${candidates.join(", ")}) in headers: ${headers.join(" | ")}`);
}

// ---------------------------------------------------------------------------

interface ExportCreateResponse {
  successful?: boolean;
  jobCode?: string;
  errors?: unknown[];
}

interface ExportStatusResponse {
  successful?: boolean;
  status?: string; // QUEUED | PROCESSING | COMPLETE | FAILED
  filePath?: string;
  errors?: unknown[];
}

interface SaleOrderGetResponse {
  successful?: boolean;
  saleOrderDTO?: UcSaleOrderDTO;
  errors?: unknown[];
}

interface ManifestGetResponse {
  successful?: boolean;
  shippingManifestDTO?: {
    noOfBoxes?: number;
    weight?: number;
    status?: { updated?: number };
    shippingPackages?: { trackingNumber?: string; noOfBoxes?: number; weight?: number }[];
  };
  errors?: unknown[];
}

export class UcApiOrderSource implements OrderSource {
  async fetchChangedOrderCodes(sinceIst: string): Promise<string[]> {
    const start = istMidnightMs(sinceIst);
    const end = Date.now();
    const create = await ucPost<ExportCreateResponse>("/services/rest/v1/export/job/create", {
      body: {
        exportJobTypeName: exportJobTypeName(),
        exportColums: [],
        exportFilters: [
          { id: "updatedAt", dateRange: { start, end } },
        ],
        frequency: "ONETIME",
      },
    });
    if (!create.jobCode) {
      throw new Error(`UC export create returned no jobCode: ${JSON.stringify(create.errors ?? create).slice(0, 300)}`);
    }

    let filePath: string | undefined;
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
      await sleep(POLL_INTERVAL_MS);
      const status = await ucPost<ExportStatusResponse>("/services/rest/v1/export/job/status", {
        body: { jobCode: create.jobCode },
      });
      if (status.status === "COMPLETE" && status.filePath) {
        filePath = status.filePath;
        break;
      }
      if (status.status === "FAILED") {
        throw new Error(`UC export job ${create.jobCode} failed: ${JSON.stringify(status.errors ?? {}).slice(0, 300)}`);
      }
    }
    if (!filePath) throw new Error(`UC export job ${create.jobCode} did not complete in time`);

    const csv = await ucDownload(filePath);
    const rows = parseCsv(csv);
    if (rows.length < 2) return [];
    const soCol = findColumn(rows[0], ["Sale Order Code", "SaleOrder Code", "Order Code", "Order Number", "Order Name"]);
    const codes = new Set<string>();
    for (const row of rows.slice(1)) {
      const code = row[soCol]?.trim();
      if (code) codes.add(code);
    }
    return [...codes];
  }

  async fetchOrder(soNumber: string): Promise<UcOrderUpdate | undefined> {
    const res = await ucPost<SaleOrderGetResponse>("/services/rest/v1/oms/saleorder/get", {
      body: { code: soNumber, facilityCodes: [...FACILITIES] },
    });
    if (!res.saleOrderDTO) return undefined;
    const update = mapSaleOrder(res.saleOrderDTO);

    // Manifest detail (facility-level API) — box count / weight / dispatch time.
    if (update.manifestCode && update.facilityCode) {
      try {
        const manifest = await ucPost<ManifestGetResponse>("/services/rest/v1/oms/shippingManifest/get", {
          facility: update.facilityCode,
          body: { shippingManifestCode: update.manifestCode },
        });
        const dto = manifest.shippingManifestDTO;
        if (dto) {
          if (dto.noOfBoxes && !update.patch.boxCount) update.patch.boxCount = dto.noOfBoxes;
          if (dto.weight && !update.patch.weightKg) update.patch.weightKg = Math.round(dto.weight / 100) / 10;
        }
      } catch {
        // Manifest detail is best-effort — saleorder/get already carries the essentials.
      }
    }
    return update;
  }
}
