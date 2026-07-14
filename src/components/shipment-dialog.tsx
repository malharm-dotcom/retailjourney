"use client";

// Shipment status update — used from the In-Transit board and Logistics queue.
// Sync flows respect the transition map; a manual actor may force any status
// (manual override is always available, PRD §2). Every change → OrderEvent.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { recordNdr, setShipmentStatus } from "@/app/actions";
import { Icon } from "@/components/icon";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button, Field, Input } from "@/components/ui/primitives";
import { SHIPMENT_LABEL } from "@/lib/journey";
import { SHIPMENT_VISUAL, cn } from "@/lib/ui";
import type { ShipmentStatus } from "@/lib/types";

const ALL: ShipmentStatus[] = ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RETURN"];

export function ShipmentDialog({
  soNumber,
  current,
  self,
  children,
}: {
  soNumber: string;
  current?: ShipmentStatus;
  self: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const apply = (to: ShipmentStatus) =>
    startTransition(async () => {
      const res =
        to === "DELIVERY_FAILED"
          ? await recordNdr(soNumber, note || undefined)
          : await setShipmentStatus(soNumber, to, note || undefined);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        to === "DELIVERY_FAILED"
          ? `NDR recorded on ${soNumber}`
          : `${soNumber} marked ${SHIPMENT_LABEL[to]}`,
      );
      setOpen(false);
      setNote("");
      router.refresh();
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        title={`Update shipment · ${soNumber}`}
        description={
          self
            ? "Self-delivery lane — no eShipz feed, status is manual only."
            : "Manual override — this will be logged over the synced status."
        }
      >
        <div className="grid grid-cols-2 gap-2">
          {ALL.map((s) => {
            const v = SHIPMENT_VISUAL[s];
            const isCurrent = current === s;
            return (
              <button
                key={s}
                disabled={pending || isCurrent}
                onClick={() => apply(s)}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[13px] font-semibold transition-all",
                  isCurrent
                    ? "cursor-default border-line bg-paper text-mute"
                    : "border-line-strong bg-paper text-ink-soft hover:border-sage hover:bg-sage-soft hover:text-sage",
                )}
              >
                <Icon name={v.icon} size={16} />
                {s === "DELIVERY_FAILED" ? "Record NDR" : v.label}
                {isCurrent ? <span className="ml-auto text-[10px]">current</span> : null}
              </button>
            );
          })}
        </div>
        <div className="mt-3">
          <Field label="Note (optional)">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. store closed, reattempt tomorrow"
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
