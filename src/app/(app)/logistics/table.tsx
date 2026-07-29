"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { overrideOrderFields } from "@/app/actions";
import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { ShipmentDialog } from "@/components/shipment-dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { StatusPill } from "@/components/ui/pill";
import { Button, Chip, Field, Input, Select } from "@/components/ui/primitives";
import type { AnchorSource } from "@/lib/transit-anchor";
import { LOGISTICS_PARTNERS, type ShipmentStatus, type Source } from "@/lib/types";
import { OVERALL_VISUAL, ROW_ACTION, SHIPMENT_VISUAL, TONE, cn, railOf } from "@/lib/ui";
import { fmtDate } from "@/lib/ist";

export interface LogisticsRow {
  so: string;
  store: string;
  facility: string;
  zone: string;
  dc?: string;
  lr?: string;
  courier?: string;
  self: boolean;
  vehicle?: string;
  eway?: string;
  dispatched?: string;
  expected?: string;
  delivered?: string;
  shipment?: ShipmentStatus;
  source: Source;
  attempts: number;
  pod?: string;
  msg?: string;
  breaching: boolean;
  ageing: number;
  /** Which anchor `ageing` was measured from — undefined when none exists. */
  ageFrom?: AnchorSource;
}

/** The age sub-line names its anchor, so a manifest- or pickup-based age is
 *  never silently passed off as time since dispatch. */
const AGE_LABEL: Record<AnchorSource, string> = {
  DISPATCHED: "in transit",
  MANIFESTED: "since manifest",
  PICKED_UP: "since pickup",
  TRACKING_PICK: "since pickup",
};

type Filter = "open" | "pending" | "transit" | "failed" | "self" | "delivered";

export function LogisticsTable({ rows, canEdit }: { rows: LogisticsRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<LogisticsRow | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const searchId = useId();

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "open" && r.delivered) return false;
      if (filter === "pending" && (r.shipment || r.delivered)) return false;
      if (filter === "transit" && !(r.shipment === "IN_TRANSIT" || r.shipment === "OUT_FOR_DELIVERY")) return false;
      if (filter === "failed" && r.shipment !== "DELIVERY_FAILED") return false;
      if (filter === "self" && !(r.self && !r.delivered)) return false;
      if (filter === "delivered" && !r.delivered) return false;
      if (
        needle &&
        ![r.so, r.lr, r.dc, r.store, r.courier].filter(Boolean).some((v) => v!.toLowerCase().includes(needle))
      )
        return false;
      return true;
    });
  }, [rows, filter, q]);

  const openEdit = (r: LogisticsRow) => {
    setForm({
      dcNumber: r.dc ?? "",
      lrNumber: r.lr ?? "",
      logisticsPartner: r.courier ?? "",
      vehicleNumber: r.vehicle ?? "",
      eWayBill: r.eway ?? "",
      expectedDate: r.expected ?? "",
      podLink: r.pod ?? "",
    });
    setEditing(r);
  };

  const saveEdit = () =>
    startTransition(async () => {
      if (!editing) return;
      const patch: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(form)) patch[k] = v.trim() === "" ? undefined : v.trim();
      const res = await overrideOrderFields(editing.so, patch, "Logistics assignment edit");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${editing.so} updated`);
      setEditing(null);
      router.refresh();
    });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">
        <Chip active={filter === "open"} onClick={() => setFilter("open")}>
          All open
        </Chip>
        <Chip active={filter === "pending"} tone="pending" onClick={() => setFilter("pending")}>
          Awaiting pickup
        </Chip>
        <Chip active={filter === "transit"} tone="motion" onClick={() => setFilter("transit")}>
          Moving
        </Chip>
        <Chip active={filter === "failed"} tone="failed" onClick={() => setFilter("failed")}>
          NDR / failed
        </Chip>
        <Chip active={filter === "self"} tone="handling" onClick={() => setFilter("self")}>
          Self-delivery (manual)
        </Chip>
        <Chip active={filter === "delivered"} tone="done" onClick={() => setFilter("delivered")}>
          Delivered 7d
        </Chip>
        <div className="ml-auto flex min-w-[230px] flex-1 items-center gap-2 rounded-control border border-line-control bg-paper px-3 text-mute sm:flex-none">
          <Icon name="magnifer-linear" size={15} />
          <label htmlFor={searchId} className="sr-only">
            Search dispatched orders by SO, LR, DC or store
          </label>
          <Input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SO · LR · DC · store"
            className="border-0 bg-transparent px-0 py-2 focus:border-0"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-card bg-card shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left">
            {/* Sticky: this table runs to hundreds of rows and the column
                meaning used to scroll away on every surface except Reports. */}
            <thead className="sticky top-[var(--bar-h)] z-10">
              <tr className="border-b border-line bg-paper text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                <th className="px-5 py-3 font-semibold">Store · SO</th>
                <th className="px-3 py-3 font-semibold">DC · LR</th>
                <th className="px-3 py-3 font-semibold">Courier</th>
                <th className="px-3 py-3 font-semibold">Status</th>
                <th className="px-3 py-3 font-semibold">Dispatched</th>
                <th className="px-3 py-3 font-semibold">Expected</th>
                <th className="px-3 py-3 text-center font-semibold">Attempts</th>
                <th className="px-3 py-3 font-semibold">POD</th>
                <th className="px-3 py-3">
                  <span className="sr-only">Row actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-12 text-center text-sm text-mute">
                    Nothing here — adjust the filters or dispatch something from the Warehouse queue.
                  </td>
                </tr>
              ) : (
                shown.map((r) => {
                  const v = r.shipment ? SHIPMENT_VISUAL[r.shipment] : OVERALL_VISUAL.PICKUP_PENDING;
                  return (
                    <tr key={r.so} className="border-b border-line last:border-b-0 hover:bg-paper">
                      <td
                        className="rail px-5 py-3"
                        style={{ "--rail": r.breaching ? TONE.failed.hex : railOf(v) } as React.CSSProperties}
                      >
                        <Link href={`/orders/${r.so}`} className="text-ui font-semibold hover:text-sage">
                          {r.store}
                        </Link>
                        <span className="mono block text-cap text-mute">
                          {r.so} · {r.zone}
                        </span>
                      </td>
                      <td className="mono px-3 py-3 text-dense">
                        <span className="block font-display font-semibold">{r.lr ?? "—"}</span>
                        <span className="block text-cap text-mute">{r.dc ?? "—"}</span>
                      </td>
                      <td className="px-3 py-3 text-dense">
                        {(r.courier ?? "—").replace("_", " ")}
                        {r.self ? (
                          <span className="mt-0.5 block w-fit rounded-full bg-ofd-bg px-2 py-0.5 text-meta font-bold text-ofd">
                            manual lane
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3">
                        <StatusPill visual={v} source={r.source} size="sm" />
                      </td>
                      <td className="mono px-3 py-3 text-dense text-ink-soft">
                        {fmtDate(r.dispatched)}
                        {r.ageFrom ? (
                          <span className="block text-cap text-mute">
                            {r.ageing}d {AGE_LABEL[r.ageFrom]}
                          </span>
                        ) : null}
                      </td>
                      <td className={cn("mono px-3 py-3 text-dense", r.breaching && !r.delivered ? "font-semibold text-breach" : "text-ink-soft")}>
                        {r.delivered ? `del. ${fmtDate(r.delivered)}` : fmtDate(r.expected)}
                      </td>
                      <td className="mono px-3 py-3 text-center text-dense">
                        <span className={cn(r.attempts > 1 && "font-bold text-breach")}>{r.attempts}</span>
                      </td>
                      <td className="px-3 py-3">
                        {r.pod ? (
                          <a
                            href={r.pod}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open proof of delivery for ${r.so} in a new tab`}
                            className="text-dense font-semibold text-sage hover:underline"
                          >
                            POD ↗
                          </a>
                        ) : (
                          <span className="text-dense text-mute">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex justify-end gap-2">
                          <JourneyLink so={r.so} />
                          {canEdit ? (
                            <>
                              <button
                                type="button"
                                aria-label={`Edit courier, LR and DC for ${r.so}`}
                                onClick={() => openEdit(r)}
                                className={ROW_ACTION}
                              >
                                <Icon name="pen-2-linear" size={15} />
                              </button>
                              {!r.delivered ? (
                                <ShipmentDialog
                                  soNumber={r.so}
                                  current={r.shipment}
                                  self={r.self}
                                  store={r.store}
                                  lr={r.lr}
                                  courier={r.courier}
                                >
                                  <button
                                    type="button"
                                    aria-label={`Update shipment status for ${r.so}`}
                                    className={ROW_ACTION}
                                  >
                                    <Icon name="delivery-bold-duotone" size={15} />
                                  </button>
                                </ShipmentDialog>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p aria-live="polite" className="px-1 pb-8 pt-4 text-dense text-mute">
        Showing <b className="font-semibold text-ink-soft">{shown.length}</b> of{" "}
        <b className="font-semibold text-ink-soft">{rows.length}</b> dispatched orders
      </p>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        {editing ? (
          <DialogContent
            title={`Dispatch details · ${editing.so}`}
            // Was "synced values keep flowing underneath", which states the
            // opposite of the actual precedence rule (manual > poller > spine).
            // A user who believed the old copy would expect their correction to
            // be quietly overwritten on the next sync, and might not make it.
            description="Manual edits are logged with your name and win over the sync — a synced value will not overwrite what you enter here."
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveEdit();
              }}
            >
              <div className="grid grid-cols-2 gap-3">
              <Field label="DC number">
                <Input value={form.dcNumber} onChange={(e) => setForm((f) => ({ ...f, dcNumber: e.target.value }))} />
              </Field>
              <Field label="LR number">
                <Input value={form.lrNumber} onChange={(e) => setForm((f) => ({ ...f, lrNumber: e.target.value }))} />
              </Field>
              <Field label="Logistics partner">
                <Select
                  value={form.logisticsPartner}
                  onChange={(e) => setForm((f) => ({ ...f, logisticsPartner: e.target.value }))}
                >
                  <option value="">Select…</option>
                  {LOGISTICS_PARTNERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Vehicle no.">
                <Input value={form.vehicleNumber} onChange={(e) => setForm((f) => ({ ...f, vehicleNumber: e.target.value }))} />
              </Field>
              <Field label="e-Way bill">
                <Input value={form.eWayBill} onChange={(e) => setForm((f) => ({ ...f, eWayBill: e.target.value }))} />
              </Field>
              <Field label="Expected date">
                <Input type="date" value={form.expectedDate} onChange={(e) => setForm((f) => ({ ...f, expectedDate: e.target.value }))} />
              </Field>
                <div className="col-span-2">
                  <Field label="POD link">
                    <Input value={form.podLink} onChange={(e) => setForm((f) => ({ ...f, podLink: e.target.value }))} placeholder="https://…" />
                  </Field>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
