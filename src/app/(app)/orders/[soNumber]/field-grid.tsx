"use client";

// Every mutable field with its provenance badge and, where the viewer's role
// allows, a manual-override edit (PRD §2: manual is always available, logged).

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { overrideOrderFields } from "@/app/actions";
import { Icon } from "@/components/icon";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { SourceBadge } from "@/components/ui/pill";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { fmtDate } from "@/lib/ist";
import { LOGISTICS_PARTNERS, type Order, type Source } from "@/lib/types";

type Right = "merch" | "wh" | "logistics" | "recon";

interface FieldDef {
  key: keyof Order;
  label: string;
  right: Right;
  kind?: "text" | "number" | "date" | "partner" | "select";
  options?: string[];
  fmt?: (v: unknown) => string;
}

const GROUPS: { title: string; icon: string; fields: FieldDef[] }[] = [
  {
    title: "Merchandising",
    icon: "tag-bold-duotone",
    fields: [
      { key: "type", label: "Order type", right: "merch", kind: "select", options: ["FRESH", "RPL", "Q_COMM", "ACC", "NON_TRADING", "OTHER"] },
      { key: "priority", label: "Priority", right: "merch", kind: "select", options: ["", "HIGH"] },
      { key: "campaignTag", label: "Campaign tag", right: "merch" },
    ],
  },
  {
    title: "Warehouse",
    icon: "box-bold-duotone",
    fields: [
      { key: "boxCount", label: "Boxes", right: "wh", kind: "number" },
      { key: "weightKg", label: "Weight (kg)", right: "wh", kind: "number" },
      { key: "pickedQty", label: "Picked qty", right: "wh", kind: "number" },
      { key: "saleInvoiceNumber", label: "Sale invoice", right: "wh" },
      { key: "rtsLogicDate", label: "RTS Logic date", right: "wh", kind: "date", fmt: (v) => fmtDate(v as string) },
    ],
  },
  {
    title: "Dispatch & shipment",
    icon: "delivery-bold-duotone",
    fields: [
      { key: "dcNumber", label: "DC number", right: "logistics" },
      { key: "lrNumber", label: "LR number", right: "logistics" },
      { key: "logisticsPartner", label: "Partner", right: "logistics", kind: "partner" },
      { key: "vehicleNumber", label: "Vehicle", right: "logistics" },
      { key: "eWayBill", label: "e-Way bill", right: "logistics" },
      { key: "expectedDate", label: "Expected date", right: "logistics", kind: "date", fmt: (v) => fmtDate(v as string) },
      { key: "podLink", label: "POD link", right: "logistics" },
      { key: "logisticsComments", label: "Comments", right: "logistics" },
    ],
  },
  {
    title: "Store receipt & reconciliation",
    icon: "clipboard-check-bold-duotone",
    fields: [
      { key: "orderReceivedDate", label: "Received on", right: "recon", kind: "date", fmt: (v) => fmtDate(v as string) },
      { key: "boxesReceived", label: "Boxes received", right: "recon", kind: "number" },
      { key: "inwardedDate", label: "Inwarded on", right: "recon", kind: "date", fmt: (v) => fmtDate(v as string) },
      { key: "stiBillNo", label: "STI bill", right: "recon" },
      { key: "receivingPv", label: "Receiving PV", right: "recon" },
      { key: "shortageQty", label: "Shortage qty", right: "recon", kind: "number" },
      { key: "excessQty", label: "Excess qty", right: "recon", kind: "number" },
      { key: "entryStatus", label: "Entry status", right: "recon", kind: "select", options: ["OPEN", "CLOSED"] },
    ],
  },
];

export function FieldGrid({
  order,
  sources,
  rights,
}: {
  order: Order;
  sources: Record<string, Source>;
  rights: Record<Right, boolean>;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<FieldDef | null>(null);
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();

  const open = (f: FieldDef) => {
    const raw = order[f.key];
    setValue(raw == null ? "" : String(raw));
    setEditing(f);
  };

  const save = () =>
    startTransition(async () => {
      if (!editing) return;
      const v = value.trim();
      const patch = {
        [editing.key]: v === "" ? undefined : editing.kind === "number" ? Number(v) : v,
      } as Partial<Order>;
      const res = await overrideOrderFields(order.soNumber, patch, "Manual override from journey view");
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${editing.label} updated`);
      setEditing(null);
      router.refresh();
    });

  return (
    <>
      <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-4">
        {GROUPS.map((g) => (
          <section key={g.title} className="overflow-hidden rounded-2xl bg-card shadow-card">
            <header className="flex items-center gap-2 border-b border-line bg-paper px-4 py-3">
              <Icon name={g.icon} size={15} className="text-sage" />
              <h3 className="text-[12.5px] font-bold">{g.title}</h3>
            </header>
            <div className="px-4 py-2">
              {g.fields.map((f) => {
                const raw = order[f.key];
                const display = raw == null || raw === "" ? "—" : f.fmt ? f.fmt(raw) : String(raw);
                const src = sources[f.key as string];
                const editable = rights[f.right];
                return (
                  <div key={String(f.key)} className="group flex items-center gap-2 border-b border-line py-2 text-[12.5px] last:border-b-0">
                    <span className="w-[42%] shrink-0 text-mute">{f.label}</span>
                    <span className="mono min-w-0 flex-1 truncate font-medium" title={display}>
                      {display}
                    </span>
                    {src ? <SourceBadge source={src} /> : null}
                    {editable ? (
                      <button
                        onClick={() => open(f)}
                        title={`Edit ${f.label}`}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-mute opacity-0 transition-opacity hover:bg-sage-soft hover:text-sage group-hover:opacity-100"
                      >
                        <Icon name="pen-2-linear" size={13} />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        {editing ? (
          <DialogContent
            title={`Override · ${editing.label}`}
            description={`${order.soNumber} — saved as ✎ manual with your name on the timeline. Manual wins over sync.`}
          >
            <Field label={editing.label}>
              {editing.kind === "partner" || editing.kind === "select" ? (
                <Select value={value} onChange={(e) => setValue(e.target.value)}>
                  {editing.kind === "partner" ? (
                    <>
                      <option value="">Select…</option>
                      {LOGISTICS_PARTNERS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </>
                  ) : (
                    (editing.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o === "" ? "—" : o}
                      </option>
                    ))
                  )}
                </Select>
              ) : (
                <Input
                  type={editing.kind === "number" ? "number" : editing.kind === "date" ? "date" : "text"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoFocus
                />
              )}
            </Field>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={pending}>
                {pending ? "Saving…" : "Save override"}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
