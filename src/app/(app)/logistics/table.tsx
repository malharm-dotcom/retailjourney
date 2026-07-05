"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { overrideOrderFields } from "@/app/actions";
import { Icon } from "@/components/icon";
import { ShipmentDialog } from "@/components/shipment-dialog";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { StatusPill } from "@/components/ui/pill";
import { Button, Chip, Field, Input, Select } from "@/components/ui/primitives";
import { LOGISTICS_PARTNERS, type ShipmentStatus, type Source } from "@/lib/types";
import { OVERALL_VISUAL, SHIPMENT_VISUAL, cn } from "@/lib/ui";
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
}

type Filter = "open" | "pending" | "transit" | "failed" | "self" | "delivered";

export function LogisticsTable({ rows, canEdit }: { rows: LogisticsRow[]; canEdit: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<LogisticsRow | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

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
        <Chip active={filter === "pending"} dot="#9A9080" onClick={() => setFilter("pending")}>
          Awaiting pickup
        </Chip>
        <Chip active={filter === "transit"} dot="#4C7A99" onClick={() => setFilter("transit")}>
          Moving
        </Chip>
        <Chip active={filter === "failed"} dot="#BE5340" onClick={() => setFilter("failed")}>
          NDR / failed
        </Chip>
        <Chip active={filter === "self"} dot="#B67F2E" onClick={() => setFilter("self")}>
          Self-delivery (manual)
        </Chip>
        <Chip active={filter === "delivered"} dot="#3E7A5C" onClick={() => setFilter("delivered")}>
          Delivered 7d
        </Chip>
        <div className="ml-auto flex min-w-[230px] items-center gap-2 rounded-xl border border-line-strong bg-paper px-3 py-1 text-mute">
          <Icon name="magnifer-linear" size={15} />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SO · LR · DC · store"
            className="border-0 bg-transparent px-0 py-1.5 focus:border-0"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl bg-card shadow-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line bg-paper text-[11.5px] font-semibold uppercase tracking-[0.04em] text-mute">
                <th className="px-5 py-3.5 font-semibold">Store · SO</th>
                <th className="px-3 py-3.5 font-semibold">DC · LR</th>
                <th className="px-3 py-3.5 font-semibold">Courier</th>
                <th className="px-3 py-3.5 font-semibold">Status</th>
                <th className="px-3 py-3.5 font-semibold">Dispatched</th>
                <th className="px-3 py-3.5 font-semibold">Expected</th>
                <th className="px-3 py-3.5 font-semibold">Attempts</th>
                <th className="px-3 py-3.5 font-semibold">POD</th>
                <th className="px-3 py-3.5" />
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
                    <tr key={r.so} className="border-b border-line last:border-b-0 hover:bg-[#FCFBF7]">
                      <td
                        className="rail px-5 py-3.5"
                        style={{ "--rail": r.breaching ? "#BE5340" : v.rail } as React.CSSProperties}
                      >
                        <Link href={`/orders/${r.so}`} className="text-[13px] font-semibold hover:text-sage">
                          {r.store}
                        </Link>
                        <span className="mono block text-[11.5px] text-mute">
                          {r.so} · {r.zone}
                        </span>
                      </td>
                      <td className="mono px-3 py-3.5 text-[12.5px]">
                        <span className="block font-display font-semibold">{r.lr ?? "—"}</span>
                        <span className="block text-[11px] text-mute">{r.dc ?? "—"}</span>
                      </td>
                      <td className="px-3 py-3.5 text-[12.5px]">
                        {(r.courier ?? "—").replace("_", " ")}
                        {r.self ? (
                          <span className="mt-0.5 block w-fit rounded-full bg-ofd-bg px-2 py-0.5 text-[10px] font-bold text-ofd">
                            manual lane
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3.5">
                        <StatusPill visual={v} source={r.source} size="sm" />
                      </td>
                      <td className="mono px-3 py-3.5 text-[12.5px] text-ink-soft">
                        {fmtDate(r.dispatched)}
                        <span className="block text-[11px] text-mute">{r.ageing}d in transit</span>
                      </td>
                      <td className={cn("mono px-3 py-3.5 text-[12.5px]", r.breaching && !r.delivered ? "font-semibold text-breach" : "text-ink-soft")}>
                        {r.delivered ? `del. ${fmtDate(r.delivered)}` : fmtDate(r.expected)}
                      </td>
                      <td className="mono px-3 py-3.5 text-center text-[12.5px]">
                        <span className={cn(r.attempts > 1 && "font-bold text-breach")}>{r.attempts}</span>
                      </td>
                      <td className="px-3 py-3.5">
                        {r.pod ? (
                          <a href={r.pod} target="_blank" rel="noreferrer" className="text-[12px] font-semibold text-sage hover:underline">
                            POD ↗
                          </a>
                        ) : (
                          <span className="text-[12px] text-mute">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3.5">
                        <div className="flex justify-end gap-1.5">
                          {canEdit ? (
                            <>
                              <button
                                title="Edit courier / LR / DC"
                                onClick={() => openEdit(r)}
                                className="grid h-8 w-8 place-items-center rounded-[9px] border border-line-strong bg-paper text-ink-soft transition-all hover:border-sage hover:bg-sage-soft hover:text-sage"
                              >
                                <Icon name="pen-2-linear" size={15} />
                              </button>
                              {!r.delivered ? (
                                <ShipmentDialog soNumber={r.so} current={r.shipment} self={r.self}>
                                  <button
                                    title="Update shipment status"
                                    className="grid h-8 w-8 place-items-center rounded-[9px] border border-line-strong bg-paper text-ink-soft transition-all hover:border-sage hover:bg-sage-soft hover:text-sage"
                                  >
                                    <Icon name="delivery-bold-duotone" size={15} />
                                  </button>
                                </ShipmentDialog>
                              ) : null}
                            </>
                          ) : (
                            <Link
                              href={`/orders/${r.so}`}
                              className="grid h-8 w-8 place-items-center rounded-[9px] border border-line-strong bg-paper text-ink-soft transition-all hover:border-sage hover:text-sage"
                            >
                              <Icon name="map-arrow-square-linear" size={15} />
                            </Link>
                          )}
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

      <div className="px-1 pb-8 pt-4 text-[12.5px] text-mute">
        Showing <b className="font-semibold text-ink-soft">{shown.length}</b> of{" "}
        <b className="font-semibold text-ink-soft">{rows.length}</b> dispatched orders
      </div>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        {editing ? (
          <DialogContent
            title={`Dispatch details · ${editing.so}`}
            description="Manual edits are logged with your name — synced values keep flowing underneath."
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
              <Button onClick={saveEdit} disabled={pending}>
                {pending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
