"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { advanceOrderStatus } from "@/app/actions";
import { advanceOrdersBulk } from "@/app/bulk-actions";
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
import { TONE, WH_STATUS_VISUAL, cn, railOf, type Tone } from "@/lib/ui";
import { BulkBar } from "./bulk-bar";
import { FilterBar } from "./filter-bar";
import type { QueueFilters } from "./filters";

export interface KanbanCard {
  so: string;
  store: string;
  qty: number;
  type: OrderType;
  channel?: string;
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

/**
 * Within a lane, cards group by how urgent their handover is.
 *
 * A lane used to be one undifferentiated column of up to 150 cards behind a
 * "Show more" button — an endless scroll where the four overdue orders that
 * actually needed a supervisor looked exactly like the hundred that did not.
 * Grouping turns a lane into three headings you can read in one glance, and a
 * collapsed group is a count rather than a scroll.
 */
type DueGroup = "overdue" | "today" | "scheduled";

const DUE_GROUPS: { key: DueGroup; label: string; tone: Tone; icon: string }[] = [
  { key: "overdue", label: "Handover overdue", tone: "failed", icon: "shield-cross-bold" },
  { key: "today", label: "Due today", tone: "staged", icon: "checklist-minimalistic-bold" },
  { key: "scheduled", label: "Scheduled", tone: "pending", icon: "clock-circle-bold" },
];

const dueGroupOf = (c: KanbanCard): DueGroup =>
  c.due === "overdue" ? "overdue" : c.due === "today" ? "today" : "scheduled";

/** Groups that start open. "Scheduled" is the long tail — it is the one you
 *  scroll past, so it starts as a count and opens on demand. */
const OPEN_BY_DEFAULT: Record<DueGroup, boolean> = { overdue: true, today: true, scheduled: false };

type Density = "comfortable" | "compact";

interface PendingMove {
  card: KanbanCard;
  to: OrderStatus;
}

export function Kanban({
  cards,
  canEdit,
  terminalCount,
  filters,
  stores,
  types,
  laneTotals,
  matchedTotal,
  scopeTotal,
  laneCap,
}: {
  cards: KanbanCard[];
  canEdit: boolean;
  terminalCount: number;
  filters: QueueFilters;
  stores: string[];
  types: OrderType[];
  /** True per-lane totals after filtering — cards[] is capped, these are not. */
  laneTotals: Record<string, number>;
  matchedTotal: number;
  scopeTotal: number;
  laneCap: number;
}) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const [move, setMove] = useState<PendingMove | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  // Comfortable shows the whole card; compact drops the meta a supervisor
  // already knows and tightens the rhythm, so roughly twice as many orders fit
  // in a lane's viewport. Same board, same actions — just less air.
  const [density, setDensity] = useState<Density>("comfortable");
  // Collapse state per lane+group. Keyed rather than nested so a lane with no
  // cards in a group never allocates anything.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // What just happened, for screen readers. The board's only feedback was a
  // toast in the far corner and an in-place animation, neither of which is
  // announced.
  const [announcement, setAnnouncement] = useState("");
  // Optimistic lane placement: the server has agreed but the router refresh has
  // not landed yet. For a bulk run this is applied to every order the server
  // said "ok" to, and pointedly NOT to the ones it skipped.
  const [optimistic, setOptimistic] = useState<Record<string, OrderStatus>>({});
  // Orders the server refused in a bulk run — they shake back into place.
  const [rejected, setRejected] = useState<Record<string, true>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Anchor for shift-click range select, per lane.
  const lastPicked = useRef<{ lane: OrderStatus; index: number } | null>(null);

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

  const laneOf = useCallback((c: KanbanCard): OrderStatus => optimistic[c.so] ?? c.status, [optimistic]);

  const byLane = useMemo(() => {
    const m = new Map<OrderStatus, KanbanCard[]>();
    for (const lane of LANES) m.set(lane, []);
    for (const c of cards) m.get(laneOf(c))?.push(c);
    for (const lane of LANES)
      m.get(lane)!.sort((a, b) => (a.due === "overdue" ? -1 : 0) - (b.due === "overdue" ? -1 : 0) || b.ageDays - a.ageDays);
    return m;
  }, [cards, laneOf]);

  const cardBySo = useMemo(() => new Map(cards.map((c) => [c.so, c])), [cards]);
  const selectedStatuses = useMemo(
    () => [...selected].map((so) => cardBySo.get(so)).filter(Boolean).map((c) => laneOf(c!)),
    [selected, cardBySo, laneOf],
  );

  const clearSelection = () => {
    setSelected(new Set());
    lastPicked.current = null;
  };

  /** Click, or shift-click for a range within the same lane. */
  const pick = (lane: OrderStatus, index: number, so: string, shift: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const list = byLane.get(lane)!;
      if (shift && lastPicked.current?.lane === lane) {
        const [a, b] = [lastPicked.current.index, index].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) next.add(list[i].so);
      } else if (next.has(so)) {
        next.delete(so);
      } else {
        next.add(so);
      }
      return next;
    });
    lastPicked.current = { lane, index };
  };

  const selectLane = (lane: OrderStatus) => {
    const list = byLane.get(lane)!;
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = list.every((c) => next.has(c.so));
      for (const c of list) (allOn ? next.delete(c.so) : next.add(c.so));
      return next;
    });
  };

  const selectAllShown = () => {
    setSelected((prev) => (prev.size === cards.length ? new Set() : new Set(cards.map((c) => c.so))));
  };

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
      // Optimistic, but only after the server confirmed: the card never moves
      // on an unsaved change. AnimatePresence plays it out of the old lane and
      // the `layout` prop reflows what is left behind.
      setOptimistic((o) => ({ ...o, [card.so]: to }));
      router.refresh();
    });

  /** The bulk path. Selected cards move the moment the server answers, then
   *  reconcile: anything skipped or failed stays put and shakes. */
  const bulkAdvance = (to: OrderStatus, sharedCaptures?: Partial<Order>) => {
    const ids = [...selected];
    startTransition(async () => {
      const res = await advanceOrdersBulk({ orderIds: ids, toStatus: to, sharedCaptures });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }

      const okIds = res.results.filter((r) => r.outcome === "ok").map((r) => r.soNumber);
      const refused = res.results.filter((r) => r.outcome !== "ok");

      if (okIds.length) {
        setOptimistic((o) => ({ ...o, ...Object.fromEntries(okIds.map((so) => [so, to])) }));
      }
      if (refused.length) {
        setRejected(Object.fromEntries(refused.map((r) => [r.soNumber, true as const])));
        setTimeout(() => setRejected({}), 700);
      }

      // One toast for the run, counts first — a per-order toast storm for a
      // forty-order dispatch is noise, not feedback.
      const parts = [`${res.advanced} moved to ${STATUS_LABEL[to]}`];
      if (res.skipped) parts.push(`${res.skipped} skipped`);
      if (res.failed) parts.push(`${res.failed} failed`);
      const summary = parts.join(" · ");
      if (res.failed) toast.error(summary, { description: refused[0]?.reason });
      else if (res.skipped) toast(summary, { description: refused[0]?.reason });
      else toast.success(summary);

      setAnnouncement(summary);
      // Keep the refused ones selected so they can be dealt with; drop the rest.
      setSelected(new Set(refused.map((r) => r.soNumber)));
      lastPicked.current = null;
      router.refresh();
    });
  };

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
      <FilterBar
        filters={filters}
        stores={stores}
        types={types}
        matchedTotal={matchedTotal}
        scopeTotal={scopeTotal}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        {canEdit && cards.length ? (
          <Button variant="ghost" onClick={selectAllShown}>
            <Icon name="check-square-bold-duotone" size={15} />
            {selected.size === cards.length ? "Deselect all" : `Select all ${cards.length} shown`}
          </Button>
        ) : null}

        {/* Density. A floor lead working a lane wants the whole card; a
            supervisor sweeping seven lanes for what is late wants twice as many
            rows on screen. Same board, two reading distances. */}
        <div
          className="ml-auto flex items-center gap-[3px] rounded-control bg-line/80 p-[3px]"
          role="group"
          aria-label="Card density"
        >
          {(["comfortable", "compact"] as Density[]).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={density === d}
              onClick={() => setDensity(d)}
              className={cn(
                "rounded-md px-3 py-[6px] text-dense font-semibold capitalize transition-[transform,background-color,color] duration-150 ease-ui active:scale-[0.97]",
                density === d ? "bg-card text-ink shadow-[0_1px_3px_rgba(39,34,27,.12)]" : "text-ink-soft hover:text-ink",
              )}
            >
              {d}
            </button>
          ))}
        </div>
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
          you scroll to is worth more than a cramped one you can see. Empty lanes
          keep full width — the old rotated slim rail read as broken layout.
          Phone width stacks the lanes vertically. */}
      <div className="mb-4 flex flex-col gap-2.5 lg:h-[calc(100dvh-var(--chrome-h))] lg:snap-x lg:snap-proximity lg:flex-row lg:gap-3 lg:overflow-x-auto lg:overflow-y-hidden lg:pb-2">
        {LANES.map((lane) => {
          const v = WH_STATUS_VISUAL[lane];
          const visible = byLane.get(lane)!;
          // The TRUE filtered total from the server, which may exceed what was
          // sent. A lane that is holding cards back has to say so.
          const total = laneTotals[lane] ?? visible.length;
          const capped = total > visible.length;
          const empty = visible.length === 0;
          const allSelected = !empty && visible.every((c) => selected.has(c.so));
          return (
            <section
              key={lane}
              className="flex flex-col lg:h-full lg:w-[264px] lg:min-w-[264px] lg:flex-none lg:snap-start"
            >
              <header
                className="sticky top-0 z-10 mb-2.5 flex items-center gap-2 rounded-control border-t-[3px] bg-card px-3 py-2.5 shadow-card"
                style={{ borderTopColor: railOf(v) }}
              >
                {canEdit && !empty ? (
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => selectLane(lane)}
                    className="h-3.5 w-3.5 shrink-0 accent-ink"
                    aria-label={`Select all ${visible.length} in ${STATUS_LABEL[lane]}`}
                    title={`Select all in ${STATUS_LABEL[lane]}`}
                  />
                ) : null}
                <Icon name={v.icon} size={15} className="shrink-0 text-ink-soft" />
                {/* No truncation: the lane is sized to its title, not the reverse. */}
                <span className="whitespace-nowrap text-dense font-bold">{STATUS_LABEL[lane]}</span>
                <motion.span
                  key={total}
                  initial={reduce ? false : { scale: 0.8, opacity: 0.5 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  className="mono ml-auto shrink-0 rounded-md bg-ground px-1.5 py-0.5 font-display text-xs font-bold text-ink-soft"
                  title={capped ? `${visible.length} of ${total} loaded` : undefined}
                >
                  {total}
                </motion.span>
              </header>

              {empty ? (
                <div className="rounded-xl border border-dashed border-line-control px-3 py-6 text-center text-cap text-mute lg:flex lg:min-h-0 lg:flex-1 lg:items-center lg:justify-center">
                  Nothing here
                </div>
              ) : (
                <div
                  className={cn(
                    "flex flex-col lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overflow-x-hidden lg:px-0.5",
                    density === "compact" ? "gap-1.5" : "gap-2",
                  )}
                >
                  {DUE_GROUPS.map((g) => {
                    const inGroup = visible.filter((c) => dueGroupOf(c) === g.key);
                    if (inGroup.length === 0) return null;
                    const key = `${lane}:${g.key}`;
                    const open = collapsed[key] ?? OPEN_BY_DEFAULT[g.key];
                    return (
                      <div key={g.key} className="flex flex-col">
                        <button
                          type="button"
                          aria-expanded={open}
                          onClick={() => setCollapsed((s) => ({ ...s, [key]: !open }))}
                          // Sticky so you always know which group you are inside
                          // once a lane is scrolling.
                          className="sticky top-0 z-[1] flex items-center gap-1.5 rounded-md bg-ground px-2 py-1.5 text-left text-meta font-bold uppercase tracking-[0.07em] transition-[transform,background-color] duration-150 ease-ui active:scale-[0.985]"
                          style={{ color: TONE[g.tone].hex }}
                        >
                          <Icon
                            name="alt-arrow-down-bold"
                            size={11}
                            className={cn("shrink-0 transition-transform duration-150 ease-ui", !open && "-rotate-90")}
                          />
                          <Icon name={g.icon} size={12} className="shrink-0" />
                          <span className="truncate">{g.label}</span>
                          <span className="mono ml-auto shrink-0 tracking-normal text-ink-soft">{inGroup.length}</span>
                        </button>
                        {open ? (
                          <div className={cn("flex flex-col pt-1.5", density === "compact" ? "gap-1" : "gap-2")}>
                            <AnimatePresence mode="popLayout" initial={false}>
                              {inGroup.map((c) => {
                                // The effective status: an optimistically advanced
                                // card must offer its NEW lane's transitions.
                                const status = laneOf(c);
                                const nexts = WH_TRANSITIONS[status].filter(
                                  (s) => WH_FLOW.includes(s) && WH_FLOW.indexOf(s) > WH_FLOW.indexOf(status),
                                );
                                const primaryNext = nexts[0];
                                const others = WH_TRANSITIONS[status].filter((s) => s !== primaryNext);
                                const isSel = selected.has(c.so);
                                const index = visible.indexOf(c);
                                return (
                                  <motion.article
                                    key={c.so}
                                    layout={reduce ? false : "position"}
                                    initial={reduce ? false : { opacity: 0, scale: 0.96 }}
                                    animate={
                                      rejected[c.so] && !reduce
                                        ? { opacity: 1, scale: 1, x: [0, -5, 5, -3, 3, 0] }
                                        : { opacity: 1, scale: 1, x: 0 }
                                    }
                                    exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -6 }}
                                    transition={
                                      reduce
                                        ? { duration: 0.12 }
                                        : rejected[c.so]
                                          ? { duration: 0.4 }
                                          : { type: "spring", stiffness: 480, damping: 36 }
                                    }
                                    className={cn(
                                      // No left accent bar and no due badge: the
                                      // card sits inside a group whose sticky
                                      // header already states the due state, in
                                      // its colour, with its count.
                                      "group relative flex flex-col rounded-control bg-card shadow-card transition-[box-shadow,border-color] duration-150 ease-ui hover:shadow-lift",
                                      density === "compact" ? "p-2.5" : "p-3",
                                      isSel && "ring-2 ring-ink",
                                      rejected[c.so] && "ring-2 ring-breach",
                                    )}
                                  >
                                    {canEdit ? (
                                      // Checkbox appears on hover / focus, and
                                      // stays put once it is carrying a
                                      // selection — a control that vanishes
                                      // under the pointer while you are picking
                                      // a range is worse than no control.
                                      <input
                                        type="checkbox"
                                        checked={isSel}
                                        onChange={(e) =>
                                          pick(lane, index, c.so, (e.nativeEvent as MouseEvent).shiftKey)
                                        }
                                        onClick={(e) => e.stopPropagation()}
                                        aria-label={`Select ${c.so}`}
                                        className={cn(
                                          "absolute right-2 top-2 h-4 w-4 accent-ink transition-opacity duration-150 ease-ui",
                                          isSel ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
                                        )}
                                      />
                                    ) : null}
                                    {/* Order number owns its line. */}
                                    <JourneyLink
                                      so={c.so}
                                      variant="text"
                                      className="mono block pr-6 font-display text-ui font-bold text-ink"
                                    />
                                    {/* A FLAG, not a breach: this order simply has
                                        no rulebook target, so it runs on a
                                        fallback EDD. Neutral pending token. */}
                                    {c.outOfRulebook ? (
                                      <div className="mt-1 flex flex-wrap items-center gap-1">
                                        <span
                                          className="rounded-md bg-pending-bg px-1.5 py-0.5 text-meta font-bold text-pending"
                                          title="No rulebook target for this store/order type — delivery target falls back to the eShipz EDD"
                                        >
                                          out of rulebook
                                        </span>
                                      </div>
                                    ) : null}
                                    {/* One clean truncation, full name on hover. */}
                                    <div className="mt-1 truncate text-ui font-semibold text-ink" title={c.store}>
                                      {c.store}
                                    </div>
                                    <div className="mt-0.5 text-cap text-mute">
                                      {c.type} · {c.qty} pcs · {c.ageDays}d old
                                      {c.priority ? " · HIGH" : ""}
                                      {status === "RTS_LOGIC" && c.invoice ? (
                                        <span className="mono"> · inv {c.invoice}</span>
                                      ) : null}
                                    </div>
                                    {/* Campaign is the first thing to go in
                                        compact: it is context, not a decision
                                        input. */}
                                    {c.campaign && density === "comfortable" ? (
                                      <div className="mt-1 truncate text-cap font-medium text-ink-soft" title={c.campaign}>
                                        {c.campaign}
                                      </div>
                                    ) : null}
                                    {canEdit && (primaryNext || others.length) ? (
                                      // mt-auto pins the action to the bottom so
                                      // cards in a lane share one rhythm even
                                      // when the meta wraps.
                                      <div className="mt-auto flex items-center gap-1.5 border-t border-line pt-2.5 [&:not(:first-child)]:mt-2.5">
                                        {primaryNext ? (
                                          <button
                                            type="button"
                                            disabled={pending}
                                            onClick={() => requestMove(c, primaryNext)}
                                            className="flex min-h-[34px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control bg-ink px-2 py-1.5 text-cap font-semibold text-paper transition-[transform,background-color] duration-150 ease-ui active:scale-[0.97] hover:bg-ink/85 disabled:opacity-50"
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
                                                className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-control border border-line-control text-ink-soft transition-[transform,border-color,color] duration-150 ease-ui active:scale-[0.97] hover:border-sage hover:text-sage"
                                                aria-label={`More transitions for ${c.so}`}
                                              >
                                                <Icon name="menu-dots-bold" size={14} />
                                              </button>
                                            </DropdownTrigger>
                                            <DropdownContent align="end">
                                              {/* Reversals first, then a separator,
                                                  then the ones that END the order. */}
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
                                                      <DropdownItem
                                                        key={s}
                                                        destructive
                                                        onSelect={() => requestMove(c, s)}
                                                      >
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
                                  </motion.article>
                                );
                              })}
                            </AnimatePresence>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {capped ? (
                    <p className="rounded-xl border border-dashed border-line-control px-3 py-2.5 text-center text-cap text-mute">
                      Showing {visible.length} of {total} — filter to narrow this lane.
                    </p>
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

      {canEdit ? (
        <BulkBar
          count={selected.size}
          statuses={selectedStatuses}
          pending={pending}
          onClear={clearSelection}
          onAdvance={bulkAdvance}
        />
      ) : null}

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
