"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { advanceOrderStatus } from "@/app/actions";
import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { REQUIRED_CAPTURES, STATUS_LABEL, WH_FLOW, WH_TRANSITIONS } from "@/lib/journey";
import { LOGISTICS_PARTNERS, type Order, type OrderStatus, type OrderType } from "@/lib/types";
import { WH_STATUS_VISUAL, cn, railOf } from "@/lib/ui";

export interface KanbanCard {
  so: string;
  store: string;
  qty: number;
  type: OrderType;
  priority?: string;
  campaign?: string;
  status: OrderStatus;
  facility: string;
  due?: "today" | "overdue";
  ageDays: number;
  boxCount?: number;
  weightKg?: number;
  invoice?: string;
  /** Spine RULEBOOK_COVERED = false: no real rulebook target, so the order runs
   *  on a fallback (eShipz EDD). It is VISIBLE — the old source hid these. */
  outOfRulebook?: boolean;
}

const LANES: OrderStatus[] = [...WH_FLOW, "ON_HOLD"];

/** Moves that end the order. Separated in the menu and confirmed in red. */
const TERMINAL_MOVES: OrderStatus[] = ["CANCELLED", "UNFULFILLABLE"];

/** Cards rendered per lane before "Show more" — keeps the DOM bounded at live
 *  volume (hundreds of orders per lane) while the lane header shows the true count. */
const LANE_PAGE = 25;

interface PendingMove {
  card: KanbanCard;
  to: OrderStatus;
}

export function Kanban({
  cards,
  canEdit,
  terminalCount,
}: {
  cards: KanbanCard[];
  canEdit: boolean;
  terminalCount: number;
}) {
  const router = useRouter();
  const [move, setMove] = useState<PendingMove | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  // Live volume is hundreds of cards per lane (RTS-Logic alone carries 150+);
  // rendering them all is a DOM/layout problem, so lanes page in increments.
  const [laneShown, setLaneShown] = useState<Record<string, number>>({});
  // Finding one order was the worst job on this board: no search, no filter, no
  // sort, against lanes that run past 150 cards behind a "Show more" button —
  // while the two sibling boards both have a search field. A supervisor holding
  // an SO from a pick list had to hold it in their head and scan seven lanes.
  const [q, setQ] = useState("");
  const searchId = useId();
  // Cards mid-departure: still drawn in their OLD lane, playing the exit. Without
  // this the card vanished from one lane and reappeared in another with nothing
  // connecting the two, so the eye could not follow the baton across the board.
  const [leaving, setLeaving] = useState<Record<string, OrderStatus>>({});
  // What just happened, for screen readers. The board's only feedback was a
  // toast in the far corner and an in-place animation, neither of which is
  // announced.
  const [announcement, setAnnouncement] = useState("");
  // Optimistic lane placement: the server action has succeeded but the router
  // refresh has not landed yet. The card moves the moment the write is
  // confirmed rather than after a full re-render, so the board never feels
  // like it stalled on a click.
  const [optimistic, setOptimistic] = useState<Record<string, OrderStatus>>({});
  // Cards that just arrived somewhere new, so they can play the landing cue.
  const [landed, setLanded] = useState<Record<string, number>>({});
  const landTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Drop an optimistic placement once the server agrees (or the order has left
  // this board entirely, e.g. cancelled). Anything else would pin a card to a
  // stale lane forever.
  useEffect(() => {
    setOptimistic((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const actual = new Map(cards.map((c) => [c.so, c.status]));
      const next: Record<string, OrderStatus> = {};
      let changed = false;
      for (const so of keys) {
        const real = actual.get(so);
        if (real === undefined || real === prev[so]) changed = true;
        else next[so] = prev[so];
      }
      return changed ? next : prev;
    });
  }, [cards]);

  useEffect(() => {
    const timers = landTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const laneOf = (c: KanbanCard): OrderStatus => optimistic[c.so] ?? c.status;

  /** Matched against SO, store and campaign — the three things a floor lead has
   *  in hand when they come to this board looking for one order. */
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    return (c: KanbanCard) =>
      [c.so, c.store, c.campaign].filter(Boolean).some((v) => v!.toLowerCase().includes(needle));
  }, [q]);

  const byLane = useMemo(() => {
    const m = new Map<OrderStatus, KanbanCard[]>();
    for (const lane of LANES) m.set(lane, []);
    for (const c of cards) {
      if (matches && !matches(c)) continue;
      m.get(optimistic[c.so] ?? c.status)?.push(c);
    }
    for (const lane of LANES)
      m.get(lane)!.sort((a, b) => (a.due === "overdue" ? -1 : 0) - (b.due === "overdue" ? -1 : 0) || b.ageDays - a.ageDays);
    return m;
  }, [cards, optimistic, matches]);

  /** Cards in scope after the search, for the result count. */
  const matchedTotal = useMemo(() => (matches ? cards.filter(matches).length : cards.length), [cards, matches]);

  const requestMove = (card: KanbanCard, to: OrderStatus) => {
    const fields = REQUIRED_CAPTURES[to] ?? [];
    const needsConfirm = ["ON_HOLD", "CANCELLED", "UNFULFILLABLE"].includes(to);
    if (fields.length === 0 && !needsConfirm) {
      commit(card, to, {});
      return;
    }
    // Values already on the order (captured earlier or synced) prefill the
    // dialog — in-flight orders never re-type what the floor already entered.
    const known: Record<string, string | number | undefined> = {
      boxCount: card.boxCount,
      weightKg: card.weightKg,
      saleInvoiceNumber: card.invoice,
    };
    const prefill: Record<string, string> = {};
    for (const f of fields) {
      const v = known[f.field as string];
      if (v != null && v !== "") prefill[f.field as string] = String(v);
    }
    setValues(prefill);
    setErrors({});
    setNote("");
    setMove({ card, to });
  };

  const commit = (card: KanbanCard, to: OrderStatus, captures: Partial<Order>, moveNote?: string) =>
    startTransition(async () => {
      const res = await advanceOrderStatus(card.so, to, captures, moveNote);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${card.so} → ${STATUS_LABEL[to]}`);
      setMove(null);
      setAnnouncement(`${card.so} moved to ${STATUS_LABEL[to]}`);

      // The hand-off, in two beats. The card first plays its exit in the lane it
      // is leaving (~170ms), then lands in the new one. Both beats are optimistic
      // but only run after the server confirmed, so a card never moves on an
      // unsaved change; the refresh below merely reconciles.
      setLeaving((l) => ({ ...l, [card.so]: to }));
      const prevTimer = landTimers.current.get(card.so);
      if (prevTimer) clearTimeout(prevTimer);
      landTimers.current.set(
        card.so,
        setTimeout(() => {
          setLeaving(({ [card.so]: _gone, ...rest }) => rest);
          setOptimistic((o) => ({ ...o, [card.so]: to }));
          setLanded((l) => ({ ...l, [card.so]: Date.now() }));
          landTimers.current.set(
            card.so,
            setTimeout(() => {
              setLanded(({ [card.so]: _drop, ...rest }) => rest);
              landTimers.current.delete(card.so);
            }, 600),
          );
          router.refresh();
        }, 170),
      );
    });

  const submitDialog = () => {
    if (!move) return;
    const fields = REQUIRED_CAPTURES[move.to] ?? [];
    const captures: Record<string, unknown> = {};
    // Validation reports itself AT the fields. It used to fire a toast into the
    // bottom-right corner while the dialog sat centred — on a 1440px floor
    // terminal that is a message ~700px from the input that caused it, and it
    // named the field without showing you which box that was.
    const bad: Record<string, string> = {};
    for (const f of fields) {
      const raw = values[f.field as string]?.trim();
      if (!raw) {
        if (!f.optional) bad[f.field as string] = "Required";
        continue;
      }
      if (f.kind === "number" && !Number.isFinite(Number(raw))) {
        bad[f.field as string] = "Numbers only";
        continue;
      }
      captures[f.field as string] = f.kind === "number" ? Number(raw) : raw;
    }
    setErrors(bad);
    if (Object.keys(bad).length > 0) return;
    commit(move.card, move.to, captures as Partial<Order>, note || undefined);
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="flex min-w-[250px] flex-1 items-center gap-2 rounded-control border border-line-control bg-paper px-3 text-mute sm:max-w-[380px] sm:flex-none">
          <Icon name="magnifer-linear" size={15} />
          <label htmlFor={searchId} className="sr-only">
            Find an order on this board by SO, store or campaign
          </label>
          <Input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find SO · store · campaign"
            className="border-0 bg-transparent px-0 py-2 focus:border-0"
          />
        </div>
        {q.trim() ? (
          <p aria-live="polite" className="text-dense text-mute">
            <b className="font-semibold text-ink-soft">{matchedTotal}</b> of {cards.length} orders match — lane counts
            below show matches only.
          </p>
        ) : null}
      </div>

      {/* Status changes are announced here. The board's feedback was a corner
          toast plus an in-place animation, so a keyboard or screen-reader user
          got no confirmation that the transition they triggered had landed. */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* Lanes are a horizontally scrolling row of FIXED-width columns. Forcing
          all seven into the viewport gave ~185px lanes at 1280px, which clipped
          lane titles, store names and the overdue tag; a comfortable lane that
          you scroll to is worth more than a cramped one you can see. Cards still
          scroll inside their lane and still page via LANE_PAGE. Empty lanes keep
          full width — the old rotated slim rail read as broken layout.
          Phone width stacks the lanes vertically. */}
      <div className="mb-4 flex flex-col gap-2.5 lg:h-[calc(100dvh-var(--chrome-h))] lg:snap-x lg:snap-proximity lg:flex-row lg:gap-3 lg:overflow-x-auto lg:overflow-y-hidden lg:pb-2">
        {LANES.map((lane) => {
          const v = WH_STATUS_VISUAL[lane];
          const list = byLane.get(lane)!;
          const shown = laneShown[lane] ?? LANE_PAGE;
          const visible = list.slice(0, shown);
          const hidden = list.length - visible.length;
          const empty = list.length === 0;
          return (
            <section
              key={lane}
              className="flex flex-col lg:h-full lg:w-[264px] lg:min-w-[264px] lg:flex-none lg:snap-start"
            >
              <header
                className="sticky top-0 z-10 mb-2.5 flex items-center gap-2 rounded-control border-t-[3px] bg-card px-3 py-2.5 shadow-card"
                style={{ borderTopColor: railOf(v) }}
              >
                <Icon name={v.icon} size={15} className="shrink-0 text-ink-soft" />
                {/* No truncation: the lane is sized to its title, not the reverse. */}
                <span className="whitespace-nowrap text-dense font-bold">{STATUS_LABEL[lane]}</span>
                <span className="mono ml-auto shrink-0 rounded-md bg-ground px-1.5 py-0.5 font-display text-xs font-bold text-ink-soft">
                  {list.length}
                </span>
              </header>

              {empty ? (
                <div className="rounded-xl border border-dashed border-line-control px-3 py-6 text-center text-cap text-mute lg:flex lg:min-h-0 lg:flex-1 lg:items-center lg:justify-center">
                  Nothing here
                </div>
              ) : (
                <div className="flex flex-col gap-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overflow-x-hidden lg:px-0.5">
                  {visible.map((c) => {
                    // The effective status: an optimistically advanced card
                    // must offer its NEW lane's transitions, not the stale ones.
                    const status = laneOf(c);
                    const nexts = WH_TRANSITIONS[status].filter((s) => WH_FLOW.includes(s) && WH_FLOW.indexOf(s) > WH_FLOW.indexOf(status));
                    const primaryNext = nexts[0];
                    const others = WH_TRANSITIONS[status].filter((s) => s !== primaryNext);
                    return (
                      <article
                        key={c.so}
                        className={cn(
                          // A left accent bar carries the due state instead of a
                          // pill on the header row — a pill had to share width
                          // with the order number and clipped to "hando overdu".
                          "group flex flex-col rounded-control border-l-[3px] bg-card p-3 shadow-card transition-[transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:shadow-lift motion-reduce:hover:translate-y-0",
                          leaving[c.so] ? "animate-cardLeave" : landed[c.so] ? "animate-cardLand" : null,
                          c.due === "overdue"
                            ? "border-l-breach"
                            : c.due === "today"
                              ? "border-l-stage"
                              : "border-l-transparent",
                        )}
                      >
                        {/* Order number owns its line. */}
                        <JourneyLink
                          so={c.so}
                          variant="text"
                          className="mono block font-display text-ui font-bold text-ink"
                        />
                        {c.due || c.outOfRulebook ? (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {c.due ? (
                              <span
                                className={cn(
                                  "rounded-md px-1.5 py-0.5 text-meta font-bold",
                                  c.due === "overdue" ? "bg-breach-bg text-breach" : "bg-stage-bg text-stage",
                                )}
                              >
                                {c.due === "overdue" ? "handover overdue" : "due today"}
                              </span>
                            ) : null}
                            {/* A FLAG, not a breach: this order simply has no
                                rulebook target, so it runs on a fallback EDD.
                                Neutral pending token — never the breach red. */}
                            {c.outOfRulebook ? (
                              <span
                                className="rounded-md bg-pending-bg px-1.5 py-0.5 text-meta font-bold text-ink-soft"
                                title="No rulebook target for this store/order type — delivery target falls back to the eShipz EDD"
                              >
                                out of rulebook
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {/* One clean truncation, full name on hover. */}
                        <div className="mt-1 truncate text-ui font-semibold text-ink" title={c.store}>
                          {c.store}
                        </div>
                        {/* The campaign tag used to sit in its own tinted band and
                            the invoice on its own line below it, which put up to
                            eight stacked bands in a 264px column. Both are meta
                            about this order, so they read as meta. */}
                        <div className="mt-0.5 text-cap text-mute">
                          {c.type} · {c.qty} pcs · {c.ageDays}d old
                          {c.priority ? " · HIGH" : ""}
                          {status === "RTS_LOGIC" && c.invoice ? <span className="mono"> · inv {c.invoice}</span> : null}
                        </div>
                        {c.campaign ? (
                          <div className="mt-1 truncate text-cap font-medium text-ink-soft" title={c.campaign}>
                            {c.campaign}
                          </div>
                        ) : null}
                        {canEdit && (primaryNext || others.length) ? (
                          // mt-auto pins the action to the bottom so cards in a
                          // lane share one rhythm even when the meta wraps.
                          <div className="mt-auto flex items-center gap-1.5 border-t border-line pt-2.5 [&:not(:first-child)]:mt-2.5">
                            {primaryNext ? (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => requestMove(c, primaryNext)}
                                // Was `hover:bg-sage`: the primary action changed
                                // colour into the chrome accent on hover, which
                                // read as a different button. It darkens instead.
                                className="flex min-h-[34px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control bg-ink px-2 py-1.5 text-cap font-semibold text-paper transition-colors hover:bg-ink/85 disabled:opacity-50"
                              >
                                <span className="truncate">{STATUS_LABEL[primaryNext]}</span>
                                <Icon name="arrow-right-linear" size={13} className="shrink-0" />
                              </button>
                            ) : null}
                            {others.length ? (
                              <Dropdown>
                                <DropdownTrigger asChild>
                                  <button
                                    type="button"
                                    className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-control border border-line-control text-ink-soft hover:border-sage hover:text-sage"
                                    aria-label={`More transitions for ${c.so}`}
                                  >
                                    <Icon name="menu-dots-bold" size={14} />
                                  </button>
                                </DropdownTrigger>
                                <DropdownContent align="end">
                                  {/* Reversals first, then a separator, then the
                                      three that END the order. All seven used to
                                      sit in one flat list, so "Cancel order" was
                                      one mis-aimed click from "Back to Picking". */}
                                  {others
                                    .filter((s) => !TERMINAL_MOVES.includes(s))
                                    .map((s) => (
                                      <DropdownItem key={s} onSelect={() => requestMove(c, s)}>
                                        <Icon name={WH_STATUS_VISUAL[s].icon} size={15} />
                                        {s === "ON_HOLD" ? "Put on hold" : `Back to ${STATUS_LABEL[s]}`}
                                      </DropdownItem>
                                    ))}
                                  <DropdownSeparator />
                                  <DropdownItem asChild>
                                    <Link href={`/orders/${c.so}`}>Open journey</Link>
                                  </DropdownItem>
                                  {others.some((s) => TERMINAL_MOVES.includes(s)) ? (
                                    <>
                                      <DropdownSeparator />
                                      {others
                                        .filter((s) => TERMINAL_MOVES.includes(s))
                                        .map((s) => (
                                          <DropdownItem key={s} destructive onSelect={() => requestMove(c, s)}>
                                            <Icon name={WH_STATUS_VISUAL[s].icon} size={15} />
                                            {s === "CANCELLED" ? "Cancel order" : "Mark unfulfillable"}
                                          </DropdownItem>
                                        ))}
                                    </>
                                  ) : null}
                                </DropdownContent>
                              </Dropdown>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                  {hidden > 0 ? (
                    <button
                      onClick={() => setLaneShown((s) => ({ ...s, [lane]: shown + LANE_PAGE * 2 }))}
                      className="rounded-xl border border-dashed border-line-control px-3 py-2.5 text-xs font-semibold text-ink-soft transition-colors hover:border-sage hover:text-sage"
                    >
                      Show more — {hidden} hidden
                    </button>
                  ) : null}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="pb-8 text-dense text-mute">
        {terminalCount} cancelled / unfulfillable orders in this scope — see Reports for the full funnel.
      </div>

      <Dialog open={move !== null} onOpenChange={(o) => !o && setMove(null)}>
        {move ? (
          <DialogContent
            title={`${STATUS_LABEL[move.to]} · ${move.card.so}`}
            description={
              TERMINAL_MOVES.includes(move.to)
                ? `${move.card.store} — this ends the order. It stops moving through the journey and leaves this board.`
                : `${move.card.store} — capture the ${STATUS_LABEL[move.to].toLowerCase()} details. Logged as a manual change.`
            }
          >
            {/* A real form: Enter submits. This was a bare <div>, so a supervisor
                doing 200 transitions a shift had to reach for the mouse at the end
                of every single one. */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitDialog();
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                {(REQUIRED_CAPTURES[move.to] ?? []).map((f) => {
                  const key = f.field as string;
                  const err = errors[key];
                  return (
                    <div key={key} className={f.kind === "partner" ? "col-span-2" : ""}>
                      <Field label={`${f.label}${f.optional ? " (optional)" : ""}`} error={err}>
                        {f.kind === "partner" ? (
                          <Select
                            invalid={Boolean(err)}
                            value={values[key] ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                          >
                            <option value="">Select partner…</option>
                            {LOGISTICS_PARTNERS.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <Input
                            invalid={Boolean(err)}
                            type={f.kind === "number" ? "number" : f.kind === "date" ? "date" : "text"}
                            value={values[key] ?? ""}
                            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                          />
                        )}
                      </Field>
                    </div>
                  );
                })}
                <div className="col-span-2">
                  <Field label="Note (optional)">
                    <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything worth logging" />
                  </Field>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setMove(null)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant={TERMINAL_MOVES.includes(move.to) ? "danger" : "primary"}
                  disabled={pending}
                >
                  {pending
                    ? "Saving…"
                    : move.to === "CANCELLED"
                      ? "Cancel this order"
                      : move.to === "UNFULFILLABLE"
                        ? "Mark unfulfillable"
                        : `Move to ${STATUS_LABEL[move.to]}`}
                </Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
