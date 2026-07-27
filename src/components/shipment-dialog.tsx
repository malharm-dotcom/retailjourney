"use client";

// Shipment status update — used from the In-Transit board and Logistics queue.
// Sync flows respect the transition map; a manual actor may force any status
// (manual override is always available, PRD §2). Every change → OrderEvent.
//
// This dialog used to be five identically-styled buttons in a 2×3 grid where one
// click wrote a TERMINAL status with no confirmation and no undo — sitting next to
// "Return" and "Record NDR", and fired from a 32px icon button in a nine-column
// table where hitting the wrong row is a routine motor slip. A false "Delivered"
// ends SLA measurement, closes the delivery leg as WITHIN_SLA, drops the order
// off the board, and cannot be walked back in the app.
//
// So: the note is captured BEFORE the actions (it used to sit below them, which
// meant the click that submitted also discarded whatever the user was about to
// type), the choices are tiered by consequence, and the two irreversible ones go
// through a confirmation that restates which shipment is about to be closed.

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

/** Statuses that end the shipment. `SHIPMENT_TRANSITIONS.DELIVERED` is empty, so
 *  there is no route out of Delivered once it is written. */
const IRREVERSIBLE: ShipmentStatus[] = ["DELIVERED", "RETURN"];

/** Mid-journey updates: safe, frequent, applied on one click. */
const ONWARD: ShipmentStatus[] = ["IN_TRANSIT", "OUT_FOR_DELIVERY"];

export function ShipmentDialog({
  soNumber,
  current,
  self,
  store,
  lr,
  courier,
  children,
}: {
  soNumber: string;
  current?: ShipmentStatus;
  self: boolean;
  /** Restated on the confirmation step so the user can see they picked the row
   *  they meant. Optional so either caller can adopt it independently. */
  store?: string;
  lr?: string;
  courier?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState<ShipmentStatus | null>(null);
  const [pending, startTransition] = useTransition();

  const close = () => {
    setOpen(false);
    setNote("");
    setConfirming(null);
  };

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
        to === "DELIVERY_FAILED" ? `NDR recorded on ${soNumber}` : `${soNumber} marked ${SHIPMENT_LABEL[to]}`,
      );
      close();
      router.refresh();
    });

  const choose = (to: ShipmentStatus) => (IRREVERSIBLE.includes(to) ? setConfirming(to) : apply(to));

  const optionClass = (isCurrent: boolean) =>
    cn(
      "flex min-h-[42px] items-center gap-2 rounded-control border px-3 py-2.5 text-ui font-semibold transition-colors",
      isCurrent
        ? "cursor-default border-line bg-paper text-mute"
        : "border-line-control bg-paper text-ink-soft hover:border-sage hover:bg-sage-soft hover:text-sage",
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) close();
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>

      {confirming ? (
        <DialogContent
          title={confirming === "DELIVERED" ? "Mark this shipment delivered?" : "Send this shipment back?"}
          description={
            confirming === "DELIVERED"
              ? "This closes the delivery leg and stops SLA measurement. There is no undo in the app."
              : "This records the shipment as returning. There is no undo in the app."
          }
        >
          {/* What is actually about to change, in the user's own vocabulary. */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-control bg-paper px-4 py-3 text-ui">
            <dt className="text-mute">SO</dt>
            <dd className="mono font-semibold">{soNumber}</dd>
            {store ? (
              <>
                <dt className="text-mute">Store</dt>
                <dd className="font-semibold">{store}</dd>
              </>
            ) : null}
            {lr ? (
              <>
                <dt className="text-mute">LR</dt>
                <dd className="mono font-semibold">{lr}</dd>
              </>
            ) : null}
            {courier ? (
              <>
                <dt className="text-mute">Courier</dt>
                <dd className="font-semibold">{courier.replace("_", " ")}</dd>
              </>
            ) : null}
            {note.trim() ? (
              <>
                <dt className="text-mute">Note</dt>
                <dd>{note.trim()}</dd>
              </>
            ) : null}
          </dl>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Back
            </Button>
            <Button variant={confirming === "DELIVERED" ? "primary" : "danger"} disabled={pending} onClick={() => apply(confirming)}>
              {pending ? "Saving…" : confirming === "DELIVERED" ? "Yes, mark delivered" : "Yes, record return"}
            </Button>
          </div>
        </DialogContent>
      ) : (
        <DialogContent
          title={`Update shipment · ${soNumber}`}
          description={
            self
              ? "Self-delivery lane — no eShipz feed, status is manual only."
              : "Manual override — logged with your name, and it wins over the synced status."
          }
        >
          {/* Note first: it belongs to whichever action follows, and putting it
              last meant the action discarded it. */}
          <Field label="Note (optional)" hint="Attached to whichever update you pick below.">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. store closed, reattempt tomorrow"
            />
          </Field>

          <p className="mb-2 mt-4 text-cap font-semibold uppercase tracking-[0.04em] text-mute">Still moving</p>
          <div className="grid grid-cols-2 gap-2">
            {ONWARD.map((s) => {
              const v = SHIPMENT_VISUAL[s];
              const isCurrent = current === s;
              return (
                <button key={s} type="button" disabled={pending || isCurrent} onClick={() => choose(s)} className={optionClass(isCurrent)}>
                  <Icon name={v.icon} size={16} />
                  {v.label}
                  {isCurrent ? <span className="ml-auto text-meta">current</span> : null}
                </button>
              );
            })}
          </div>

          <p className="mb-2 mt-4 text-cap font-semibold uppercase tracking-[0.04em] text-mute">
            Something went wrong
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => choose("DELIVERY_FAILED")}
            className={cn(optionClass(false), "w-full")}
          >
            <Icon name={SHIPMENT_VISUAL.DELIVERY_FAILED.icon} size={16} />
            Record NDR — a failed attempt
          </button>

          <p className="mb-2 mt-4 text-cap font-semibold uppercase tracking-[0.04em] text-mute">
            Closes the shipment · asks you to confirm
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              disabled={pending || current === "DELIVERED"}
              onClick={() => choose("DELIVERED")}
              className="w-full"
            >
              <Icon name={SHIPMENT_VISUAL.DELIVERED.icon} size={16} />
              {current === "DELIVERED" ? "Already delivered" : "Delivered"}
            </Button>
            <Button
              variant="outline"
              disabled={pending || current === "RETURN"}
              onClick={() => choose("RETURN")}
              className="w-full"
            >
              <Icon name={SHIPMENT_VISUAL.RETURN.icon} size={16} />
              Return
            </Button>
          </div>

          <div className="mt-5 flex justify-end border-t border-line pt-3">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
