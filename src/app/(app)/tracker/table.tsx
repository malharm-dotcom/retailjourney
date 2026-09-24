"use client";

// The tracker table + its one form. Reads like the team's sheet — dispatch
// date first, newest on top — with the app's live status as the one column the
// sheet could never have.

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { saveTrackerEntry } from "@/app/tracker-actions";
import { Icon } from "@/components/icon";
import { JourneyLink } from "@/components/journey-link";
import { StatusPill } from "@/components/ui/pill";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Pager } from "@/components/ui/pager";
import { Button, Field, Input, Select } from "@/components/ui/primitives";
import { Spinner } from "@/components/ui/spinner";
import { TABLE_PAGE_SIZE, usePaged } from "@/components/ui/use-paged";
import { fmtDate } from "@/lib/ist";
import { TRACKER_OPTIONS, type LiveOrder, type TrackerErrors } from "@/lib/logistics-tracker";
import { OVERALL_VISUAL, SHIPMENT_VISUAL } from "@/lib/ui";

export interface TrackerRow {
  id: string;
  dispatchDate: string;
  dcNumber?: string;
  lrNumber?: string;
  quantity?: number;
  boxes?: number;
  storeName: string;
  storeCity?: string;
  storeState?: string;
  expectedDate?: string;
  orderType?: string;
  dispatchType?: string;
  shipmentStatus?: string;
  deliveredDate?: string;
  orderPlacedDate?: string;
  soNumber?: string;
  facility?: string;
  allocationType?: string;
  courierPartner?: string;
  remarks?: string;
  updatedByName: string;
  updatedAt: string;
  live?: LiveOrder;
}

/** A closed order's verdict is the order's; an open one's is the courier's. */
function liveVisual(l: LiveOrder) {
  if (["DELIVERED", "INWARDED", "CLOSED"].includes(l.overallStatus) || !l.shipmentStatus) return OVERALL_VISUAL[l.overallStatus];
  return SHIPMENT_VISUAL[l.shipmentStatus];
}

const TH = "sticky top-0 z-10 bg-card px-3 py-2.5 text-left text-cap font-semibold uppercase tracking-[0.04em] text-mute";
const TD = "px-3 py-2.5 align-top text-ui";
const dash = <span className="text-mute">—</span>;

export function TrackerTable({ rows }: { rows: TrackerRow[] }) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<TrackerRow | "new" | null>(null);
  const searchId = useId();

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter((r) =>
      [r.soNumber, r.lrNumber, r.dcNumber, r.storeName, r.storeCity, r.courierPartner, r.allocationType, r.remarks]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(n)),
    );
  }, [rows, q]);
  const { rows: paged, page, setPage } = usePaged(shown, q);
  const matched = rows.filter((r) => r.live).length;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="flex min-w-[230px] flex-1 items-center gap-2 rounded-control border border-line-control bg-paper px-3 text-mute sm:max-w-[340px] sm:flex-none">
          <Icon name="magnifer-linear" size={15} />
          <label htmlFor={searchId} className="sr-only">
            Find an entry by SO, LR, DC, store, courier or remarks
          </label>
          <Input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find SO · LR · DC · store"
            className="border-0 bg-transparent px-0 py-2 focus:border-0"
          />
        </div>
        <p className="text-dense text-mute">
          <b className="font-semibold text-ink-soft">{shown.length}</b> {shown.length === 1 ? "entry" : "entries"}
          {rows.length ? ` · ${matched} matched to an order in the app` : ""}
        </p>
        <Button className="ml-auto" onClick={() => setEditing("new")}>
          <Icon name="add-circle-bold-duotone" size={16} />
          Add dispatch
        </Button>
      </div>

      <div className="overflow-x-auto rounded-card bg-card shadow-card">
        {rows.length === 0 ? (
          <div className="px-6 py-14 text-center text-sm text-mute">
            <span className="block font-semibold text-ink">No dispatches logged yet.</span>
            Add the first one — UC orders and the ones UC never sees (non-trading, accessories) alike.
          </div>
        ) : shown.length === 0 ? (
          <div className="px-6 py-14 text-center text-sm text-mute">Nothing matches that search.</div>
        ) : (
          <table className="w-full min-w-[1180px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={TH}>Date</th>
                <th className={TH}>DC · LR</th>
                <th className={TH}>Store</th>
                <th className={TH}>Type · allocation</th>
                <th className={TH}>Qty · boxes</th>
                <th className={TH}>Courier</th>
                <th className={TH}>Status entered</th>
                <th className={TH}>In the app</th>
                <th className={TH}>EDD · delivered</th>
                <th className={TH}>Remarks</th>
                <th className={TH}>
                  <span className="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-b-0 transition-colors duration-150 ease-ui hover:bg-paper">
                  <td className={TD}>
                    <span className="mono whitespace-nowrap font-semibold text-ink">{fmtDate(r.dispatchDate)}</span>
                    <span className="block text-cap text-mute">{r.facility ?? ""}</span>
                  </td>
                  <td className={TD}>
                    <span className="mono block">{r.dcNumber ?? dash}</span>
                    <span className="mono block text-cap text-mute">{r.lrNumber ?? "no LR"}</span>
                  </td>
                  <td className={TD}>
                    <span className="block max-w-[220px] truncate font-semibold text-ink" title={r.storeName}>
                      {r.storeName}
                    </span>
                    <span className="block text-cap text-mute">{[r.storeCity, r.storeState].filter(Boolean).join(", ")}</span>
                  </td>
                  <td className={TD}>
                    <span className="block">{[r.orderType, r.dispatchType].filter(Boolean).join(" · ") || dash}</span>
                    <span className="block text-cap text-mute">{r.allocationType ?? ""}</span>
                  </td>
                  <td className={`${TD} mono whitespace-nowrap`}>
                    {r.quantity ?? "—"} · {r.boxes ?? "—"}
                  </td>
                  <td className={TD}>
                    <span className="block max-w-[150px] truncate" title={r.courierPartner}>
                      {r.courierPartner ?? dash}
                    </span>
                  </td>
                  <td className={TD}>{r.shipmentStatus ?? dash}</td>
                  <td className={TD}>
                    {r.live ? (
                      <>
                        <StatusPill visual={liveVisual(r.live)} size="sm" />
                        <JourneyLink so={r.live.soNumber} variant="text" className="mono mt-1 block text-cap" />
                      </>
                    ) : (
                      <span className="text-cap text-mute" title="No order in the app has this SO or LR — typical for non-UC dispatches">
                        Not in app
                      </span>
                    )}
                    {r.soNumber && r.live?.soNumber !== r.soNumber ? (
                      <span className="mono block text-cap text-mute">{r.soNumber}</span>
                    ) : null}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    <span className="block">{r.expectedDate ? fmtDate(r.expectedDate) : dash}</span>
                    <span className="block text-cap text-mute">
                      {r.deliveredDate ? `Delivered ${fmtDate(r.deliveredDate)}` : r.live?.deliveredDate ? `App: ${fmtDate(r.live.deliveredDate)}` : ""}
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="line-clamp-2 max-w-[220px] text-dense text-ink-soft" title={r.remarks}>
                      {r.remarks ?? ""}
                    </span>
                  </td>
                  <td className={`${TD} text-right`}>
                    <button
                      type="button"
                      onClick={() => setEditing(r)}
                      aria-label={`Edit the ${fmtDate(r.dispatchDate)} dispatch to ${r.storeName}`}
                      title={`Last edited by ${r.updatedByName}`}
                      className="grid h-9 w-9 place-items-center rounded-control text-ink-soft transition-[transform,background-color] duration-150 ease-ui hover:bg-line/60 active:scale-[0.94]"
                    >
                      <Icon name="pen-2-linear" size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="mt-3">
        <Pager page={page} pageSize={TABLE_PAGE_SIZE} total={shown.length} onPage={setPage} />
      </div>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        {editing !== null ? (
          <EntryForm key={editing === "new" ? "new" : editing.id} entry={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />
        ) : null}
      </Dialog>
    </>
  );
}

type FieldKey = keyof TrackerErrors;

function EntryForm({ entry, onDone }: { entry?: TrackerRow; onDone: () => void }) {
  const router = useRouter();
  const [errors, setErrors] = useState<TrackerErrors>({});
  const [pending, start] = useTransition();
  const listId = useId();

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget));
    start(async () => {
      const res = await saveTrackerEntry(raw, entry?.id);
      if (!res.ok) {
        setErrors(res.errors ?? {});
        if (res.error) toast.error(res.error);
        return;
      }
      toast.success(entry ? "Dispatch updated" : "Dispatch added");
      onDone();
      router.refresh();
    });
  };

  const text = (name: FieldKey, label: string, opts: { type?: string; list?: readonly string[]; placeholder?: string; required?: boolean } = {}) => {
    const v = entry?.[name as keyof TrackerRow];
    return (
      <Field label={label} error={errors[name]}>
        <Input
          name={name}
          type={opts.type ?? "text"}
          defaultValue={v === undefined ? "" : String(v)}
          list={opts.list ? `${listId}-${name}` : undefined}
          placeholder={opts.placeholder}
          required={opts.required}
          invalid={Boolean(errors[name])}
          inputMode={opts.type === "number" ? "numeric" : undefined}
          min={opts.type === "number" ? 0 : undefined}
        />
        {opts.list ? (
          <datalist id={`${listId}-${name}`}>
            {opts.list.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        ) : null}
      </Field>
    );
  };

  return (
    <DialogContent
      title={entry ? "Edit dispatch" : "Add a dispatch"}
      description="Only the date and store are required. An SO or LR that matches an order in the app links to it automatically."
      className="w-[min(94vw,720px)]"
    >
      <form onSubmit={submit} noValidate className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {text("dispatchDate", "Dispatch date", { type: "date", required: true })}
        <Field label="Facility" error={errors.facility}>
          <Select name="facility" defaultValue={entry?.facility ?? ""}>
            <option value="">—</option>
            {TRACKER_OPTIONS.facility.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
        {text("dcNumber", "DC no.")}
        {text("lrNumber", "LR no. / AWB")}
        {text("soNumber", "SO number", { placeholder: "e.g. HSRLAY16990, or CARRY BAG" })}
        {text("orderPlacedDate", "Order placed", { type: "date" })}
        <div className="sm:col-span-2">{text("storeName", "Store", { required: true, placeholder: "SNITCH - COCO - HSR LAYOUT" })}</div>
        {text("storeCity", "Store city")}
        {text("storeState", "Store state")}
        {text("quantity", "Quantity", { type: "number" })}
        {text("boxes", "Boxes", { type: "number" })}
        {text("orderType", "Order type", { list: TRACKER_OPTIONS.orderType })}
        {text("dispatchType", "Dispatch type", { list: TRACKER_OPTIONS.dispatchType })}
        {text("allocationType", "Allocation type", { list: TRACKER_OPTIONS.allocationType })}
        {text("courierPartner", "Courier partner", { list: TRACKER_OPTIONS.courierPartner })}
        {text("expectedDate", "Expected date", { type: "date" })}
        {text("shipmentStatus", "Shipment status", { list: TRACKER_OPTIONS.shipmentStatus })}
        {text("deliveredDate", "Delivered date", { type: "date" })}
        <div className="sm:col-span-2">
          <Field label="Remarks" error={errors.remarks}>
            <textarea
              name="remarks"
              rows={3}
              maxLength={1000}
              defaultValue={entry?.remarks ?? ""}
              className="w-full rounded-control border border-line-control bg-paper px-3 py-2 text-ui text-ink outline-none transition-colors duration-150 ease-ui placeholder:text-mute focus:border-sage"
            />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          {entry ? <span className="mr-auto text-cap text-mute">Last edited by {entry.updatedByName}</span> : null}
          <Button variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner size={13} /> : null}
            {entry ? "Save" : "Add dispatch"}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
