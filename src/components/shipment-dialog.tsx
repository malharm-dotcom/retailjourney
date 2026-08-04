"use client";

// Shipment status update — the Logistics (courier-action) lens only. In-Transit
// is a view-only visibility lens and deliberately has no edit affordance.
//
// Manual edits walk the LINEAR LADDER and only forwards:
//   Awaiting Pickup → Picked Up → In Transit → Out for Delivery → Delivered
// Delivery Failed and Return are off that ladder. They are courier facts the
// poller owns, and they are not offered as stage targets here — a person
// telling the system a parcel "is returning" is a guess; the carrier scan is
// the fact. (Recording an NDR *attempt* is still available below: that is a
// counter, not a stage move.)
//
// The forward-only rule is enforced server-side in checkManualStage. This UI
// only renders what the server would accept — it is a courtesy, not the guard.
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
// type), the choices are tiered by consequence, and the irreversible one goes
// through a confirmation that restates which shipment is about to be closed.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { recordNdr, updateShipmentManually } from "@/app/actions";
import { Icon } from "@/components/icon";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Button, Field, Input } from "@/components/ui/primitives";
import { SHIPMENT_LABEL, SHIPMENT_LADDER, isLadderStatus, ladderOrdinal } from "@/lib/journey";
import { fmtDate } from "@/lib/ist";
import { SHIPMENT_VISUAL, cn } from "@/lib/ui";
import type { ShipmentStatus } from "@/lib/types";

/** Rungs strictly ahead of `current`. Equal-or-behind is refused by the server,
 *  so offering it would only teach the user that this dialog lies. */
function forwardTargets(current?: ShipmentStatus): ShipmentStatus[] {
  if (current !== undefined && !isLadderStatus(current)) return [];
  const from = ladderOrdinal(current);
  return SHIPMENT_LADDER.filter((_, i) => from === undefined || i > from);
}

export function ShipmentDialog({
  soNumber,
  current,
  self,
  store,
  lr,
  courier,
  pickup,
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
  /** Already-recorded pickup date. Present = set-once has fired and the field
   *  is closed; the server would ignore a second value anyway. */
  pickup?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pickupDate, setPickupDate] = useState("");
  const [confirming, setConfirming] = useState<ShipmentStatus | null>(null);
  const [pending, startTransition] = useTransition();

  const targets = forwardTargets(current);
  const onward = targets.filter((s) => s !== "DELIVERED");
  const canDeliver = targets.includes("DELIVERED");
  const offLadder = current !== undefined && !isLadderStatus(current);

  const close = () => {
    setOpen(false);
    setNote("");
    setPickupDate("");
    setConfirming(null);
  };

  const done = (msg: string) => {
    toast.success(msg);
    close();
    router.refresh();
  };

  /** Stage move (optionally carrying the pickup date entered above). */
  const apply = (to: ShipmentStatus) =>
    startTransition(async () => {
      const res = await updateShipmentManually(
        soNumber,
        { to, pickupDate: pickupDate || undefined },
        note || undefined,
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      done(`${soNumber} marked ${SHIPMENT_LABEL[to]}`);
    });

  /** Pickup date on its own — the common correction for a self-delivery lane
   *  whose stage is already right. */
  const savePickup = () =>
    startTransition(async () => {
      const res = await updateShipmentManually(soNumber, { pickupDate }, note || undefined);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      done(`Pickup date recorded on ${soNumber}`);
    });

  const ndr = () =>
    startTransition(async () => {
      const res = await recordNdr(soNumber, note || undefined);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      done(`NDR recorded on ${soNumber}`);
    });

  const choose = (to: ShipmentStatus) => (to === "DELIVERED" ? setConfirming(to) : apply(to));

  const optionClass = (isCurrent: boolean) =>
    cn(
      "flex min-h-[42px] items-center gap-2 rounded-control border px-3 py-2.5 text-ui font-semibold transition-colors duration-150 ease-ui",
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
          title="Mark this shipment delivered?"
          description="This closes the delivery leg and stops SLA measurement. There is no undo in the app."
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
            <Button variant="primary" disabled={pending} onClick={() => apply(confirming)}>
              {pending ? "Saving…" : "Yes, mark delivered"}
            </Button>
          </div>
        </DialogContent>
      ) : (
        <DialogContent
          title={`Update shipment · ${soNumber}`}
          description={
            self
              ? "Self-delivery lane — no eShipz feed, so this is the only thing that moves it."
              : "Manual edit — logged with your name. Status only moves forward."
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

          <p className="mb-2 mt-4 text-cap font-semibold uppercase tracking-[0.04em] text-mute">Pickup date</p>
          {pickup ? (
            // Set-once. Showing it read-only is more honest than an input the
            // server would silently ignore.
            <p className="rounded-control bg-paper px-3 py-2.5 text-ui text-ink-soft">
              Collected {fmtDate(pickup)}
              <span className="mt-0.5 block text-cap text-mute">
                Recorded once and kept — it anchors the courier-pickup SLA leg.
              </span>
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="" hint="The day the courier actually collected it.">
                <Input type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)} />
              </Field>
              <Button variant="outline" disabled={pending || !pickupDate} onClick={savePickup}>
                Save date
              </Button>
            </div>
          )}

          {offLadder ? (
            <p className="mt-4 rounded-control bg-paper px-3 py-2.5 text-ui text-mute">
              This shipment is {SHIPMENT_LABEL[current!]}. Courier tracking resolves it from here — there
              is no stage to set by hand.
            </p>
          ) : (
            <>
              {onward.length > 0 ? (
                <>
                  <p className="mb-2 mt-4 text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                    Move forward to
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {onward.map((s) => {
                      const v = SHIPMENT_VISUAL[s];
                      return (
                        <button
                          key={s}
                          type="button"
                          disabled={pending}
                          onClick={() => choose(s)}
                          className={optionClass(false)}
                        >
                          <Icon name={v.icon} size={16} />
                          {v.label}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}

              {current ? (
                <p className="mt-3 text-cap text-mute">
                  Currently {SHIPMENT_LABEL[current]}. Earlier stages are not offered — status never
                  moves backwards.
                </p>
              ) : null}
            </>
          )}

          <p className="mb-2 mt-4 text-cap font-semibold uppercase tracking-[0.04em] text-mute">
            Something went wrong
          </p>
          {/* Not a stage move: this bumps the attempt counter and flags the
              shipment. It is the one off-ladder write a human may make, because
              a failed attempt is something the person at the door knows first. */}
          <button
            type="button"
            disabled={pending}
            onClick={ndr}
            className={cn(optionClass(false), "w-full")}
          >
            <Icon name={SHIPMENT_VISUAL.DELIVERY_FAILED.icon} size={16} />
            Record NDR — a failed attempt
          </button>

          {canDeliver ? (
            <>
              <p className="mb-2 mt-4 text-cap font-semibold uppercase tracking-[0.04em] text-mute">
                Closes the shipment · asks you to confirm
              </p>
              <Button disabled={pending} onClick={() => choose("DELIVERED")} className="w-full">
                <Icon name={SHIPMENT_VISUAL.DELIVERED.icon} size={16} />
                Delivered
              </Button>
            </>
          ) : null}

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
