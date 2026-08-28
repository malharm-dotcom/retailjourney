"use client";

// CSV import for the two transitions that carry PER-ORDER detail.
//
// The bulk bar's shared-capture dialog is right for one truck and wrong for one
// box count: a single invoice number cannot describe 290 orders. This is the
// per-row path — download a template, fill a row per order, upload, read a dry
// run, then confirm.
//
// Three phases in one dialog, because they are one task: pick → preview → done.
// Nothing is written until the operator has seen the preview and pressed
// confirm; the file text is what gets sent to the server both times, so the
// confirm re-validates from the same source rather than trusting a payload the
// browser could have edited in between.

import { useState } from "react";
import { toast } from "sonner";
import {
  previewCsvImport,
  runCsvImport,
  type ImportPreview,
  type ImportRun,
} from "@/app/import-actions";
import { Icon } from "@/components/icon";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button, Field, Select } from "@/components/ui/primitives";
import { csvCell, csvFilename, downloadCsv, parseCsv } from "@/lib/csv";
import {
  IMPORT_TARGETS,
  MAX_IMPORT_ROWS,
  SO_HEADER,
  templateColumns,
  templateNote,
  type ImportTarget,
} from "@/lib/csv-import";
import { STATUS_LABEL } from "@/lib/journey";
import type { Order } from "@/lib/types";
import { cn } from "@/lib/ui";
import type { QueueRow } from "./table";

/** Values the board already holds, so a pre-populated template arrives with the
 *  columns the floor has already filled once. QUANTITY is left blank on purpose
 *  — blank means "the ordered quantity", which is the answer for most rows. */
const KNOWN: Partial<Record<keyof Order, (r: QueueRow) => string | number | undefined>> = {
  boxCount: (r) => r.boxCount,
  weightKg: (r) => r.weightKg,
  saleInvoiceNumber: (r) => r.invoice,
};

/** The template: note line, headers, then either one worked example or one row
 *  per selected order. */
function templateCsv(to: ImportTarget, rows: QueueRow[]): string {
  const cols = templateColumns(to);
  // Quoted as a single cell so the note lands in A1 rather than smeared across
  // the sheet — parseImportRows skips it either way.
  const lines = [csvCell(templateNote(to)), cols.map((c) => csvCell(c.header)).join(",")];
  if (rows.length === 0) {
    lines.push(cols.map((c) => csvCell(c.example)).join(","));
  } else {
    for (const r of rows) {
      lines.push(
        cols
          .map((c) => csvCell(c.header === SO_HEADER ? r.so : c.field ? KNOWN[c.field]?.(r) : undefined))
          .join(","),
      );
    }
  }
  return lines.join("\r\n");
}

/** Status ramp, not chrome: sage is deliberately excluded — it means "active
 *  control" everywhere else in the app and never carries a verdict. */
const VERDICT_TONE: Record<"ready" | "skip" | "error", string> = {
  ready: "text-deliv",
  skip: "text-mute",
  error: "text-breach",
};

export function ImportDialog({
  open,
  onOpenChange,
  to,
  onToChange,
  selected,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which template to open on. Owned by the board so the bulk bar can aim it. */
  to: ImportTarget;
  onToChange: (to: ImportTarget) => void;
  /** Rows currently ticked on the board — used only to pre-populate a template. */
  selected: QueueRow[];
  onImported: () => void;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [busy, setBusy] = useState(false);

  /** Back to phase one, keeping the chosen transition. */
  const resetFile = () => {
    setFileName(null);
    setCsvText(null);
    setPreview(null);
    setRun(null);
  };

  const close = () => {
    onOpenChange(false);
    // Deferred so the exit animation does not play against a re-rendering body.
    setTimeout(resetFile, 200);
  };

  const download = (rows: QueueRow[]) => {
    const name = csvFilename(`${to === "RTS_LOGIC" ? "rts-logic" : "dispatch"}-import${rows.length ? "-selected" : "-template"}`);
    downloadCsv(name, templateCsv(to, rows));
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    resetFile();
    // Read in the browser and send the TEXT: a server action takes a plain
    // string, so this needs no multipart route handler and no new endpoint —
    // the import runs on the same guarded action surface as every other
    // transition.
    const text = await file.text();
    setFileName(file.name);
    setCsvText(text);
    setBusy(true);
    const res = await previewCsvImport({ to, csvText: text });
    setBusy(false);
    setPreview(res);
    if (!res.ok) toast.error(res.error);
  };

  const confirm = async () => {
    if (!csvText) return;
    setBusy(true);
    const res = await runCsvImport({ to, csvText });
    setBusy(false);
    setRun(res);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    const summary = `${res.moved} moved${res.skipped ? `, ${res.skipped} skipped` : ""}`;
    if (res.moved) toast.success(summary);
    else toast(summary);
    onImported();
  };

  /** The failed rows, re-emitted AS THEY WERE WRITTEN plus a reason column, so
   *  the file can be fixed in place and uploaded again. Rebuilt from the
   *  original text rather than from the results, which carry no cell values. */
  const downloadErrors = () => {
    if (!csvText || !run?.ok) return;
    const failed = new Map(run.results.filter((r) => !r.success).map((r) => [r.soNumber, r.error ?? ""]));
    const all = parseCsv(csvText).filter(
      (cells) => cells.some((c) => c.trim() !== "") && !cells[0].trimStart().startsWith("#"),
    );
    const [header, ...body] = all;
    const soAt = header.findIndex((h) => h.trim().toUpperCase() === SO_HEADER);
    const lines = [[...header.map(csvCell), csvCell("REASON")].join(",")];
    for (const cells of body) {
      const so = (cells[soAt] ?? "").trim();
      if (!failed.has(so)) continue;
      lines.push([...cells.map(csvCell), csvCell(failed.get(so))].join(","));
    }
    downloadCsv(csvFilename("import-errors"), lines.join("\r\n"));
  };

  const cols = templateColumns(to);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      {open ? (
        <DialogContent
          className="w-[min(94vw,780px)]"
          title="Import per-order details from CSV"
          description="One row per order. Box counts, weights and invoices describe a single order each — they cannot be typed once and applied to a selection, so they arrive in a file."
        >
          {/* ---- Phase 3: what happened ---- */}
          {run?.ok ? (
            <div>
              <p className="text-ui font-semibold">
                {run.moved} moved to {STATUS_LABEL[run.to]}
                {run.skipped ? ` · ${run.skipped} skipped` : ""}
              </p>
              <ResultList
                rows={run.results.map((r) => ({
                  key: r.soNumber,
                  so: r.soNumber,
                  tone: r.success ? "ready" : "skip",
                  right: r.success ? "moved" : (r.error ?? "skipped"),
                }))}
              />
              <div className="mt-4 flex justify-end gap-2">
                {run.skipped ? (
                  <Button variant="outline" onClick={downloadErrors}>
                    <Icon name="download-minimalistic-bold" size={15} aria-hidden />
                    Download {run.skipped} unmoved
                  </Button>
                ) : null}
                <Button onClick={close}>Done</Button>
              </div>
            </div>
          ) : preview?.ok ? (
            /* ---- Phase 2: the dry run ---- */
            <div>
              <p className="text-ui">
                <b className="font-semibold">{preview.ready}</b> ready to move to {STATUS_LABEL[preview.to]}
                {preview.skipped ? ` · ${preview.skipped} skipped` : ""}
                {preview.invalid ? ` · ${preview.invalid} invalid` : ""}
              </p>
              <p className="mt-1 text-dense text-mute">
                Nothing has been written yet. {fileName}
              </p>
              <ResultList
                rows={preview.rows.map((r) => ({
                  key: `${r.line}`,
                  so: r.soNumber || `row ${r.line}`,
                  sub: r.store,
                  tone: r.verdict,
                  right: r.reason ?? (r.currentStage ? `${STATUS_LABEL[r.currentStage]} →` : "ready"),
                }))}
              />
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={resetFile} disabled={busy}>
                  Choose another file
                </Button>
                <Button onClick={confirm} disabled={busy || preview.ready === 0}>
                  {busy ? "Importing…" : `Import ${preview.ready}`}
                </Button>
              </div>
            </div>
          ) : (
            /* ---- Phase 1: pick a transition, get a template, upload ---- */
            <div className="grid gap-4">
              <Field label="Which move" hint={`One row per order, up to ${MAX_IMPORT_ROWS} at a time.`}>
                <Select
                  value={to}
                  onChange={(e) => (onToChange(e.target.value as ImportTarget), resetFile())}
                  disabled={busy}
                >
                  {IMPORT_TARGETS.map((t) => (
                    <option key={t} value={t}>
                      {t === "RTS_LOGIC" ? "Ready to Dispatch → RTS Logic" : "RTS Logic → Dispatched"}
                    </option>
                  ))}
                </Select>
              </Field>

              <div>
                <p className="text-dense text-mute">
                  Columns:{" "}
                  {cols.map((c, i) => (
                    <span key={c.header}>
                      {i > 0 ? ", " : ""}
                      <span className={cn("mono", c.optional ? "text-mute" : "font-semibold text-ink-soft")}>
                        {c.header}
                      </span>
                      {c.optional ? " (optional)" : ""}
                    </span>
                  ))}
                  . Dates DD-MM-YYYY, IST.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => download([])}>
                    <Icon name="download-minimalistic-bold" size={15} aria-hidden />
                    Sample template
                  </Button>
                  {selected.length ? (
                    <Button variant="outline" onClick={() => download(selected)}>
                      <Icon name="download-minimalistic-bold" size={15} aria-hidden />
                      Download {selected.length} selected
                    </Button>
                  ) : null}
                </div>
              </div>

              <Field label="Filled-in file" hint={busy ? "Checking…" : undefined}>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={busy}
                  onChange={(e) => onFile(e.target.files?.[0])}
                  className="w-full rounded-control border border-line-control bg-paper px-3 py-2 text-ui text-ink-soft file:mr-3 file:rounded-control file:border-0 file:bg-line file:px-3 file:py-1 file:text-cap file:font-semibold file:text-ink"
                />
              </Field>

              <div className="flex justify-end">
                <Button variant="ghost" onClick={close} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** The per-row breakdown, shared by the preview and the result report. Scrolls
 *  rather than growing the dialog past the viewport on a 500-row file. */
function ResultList({
  rows,
}: {
  rows: { key: string; so: string; sub?: string; tone: "ready" | "skip" | "error"; right: string }[];
}) {
  return (
    <ul className="mt-3 max-h-[46vh] divide-y divide-line overflow-y-auto rounded-control border border-line">
      {rows.map((r) => (
        <li key={r.key} className="flex items-baseline gap-3 px-3 py-2">
          <span className="mono shrink-0 text-dense font-semibold text-ink">{r.so}</span>
          {r.sub ? <span className="truncate text-dense text-mute">{r.sub}</span> : null}
          <span className={cn("ml-auto shrink-0 text-cap font-semibold", VERDICT_TONE[r.tone])}>{r.right}</span>
        </li>
      ))}
    </ul>
  );
}
