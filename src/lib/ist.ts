// IST helpers — the single place time math lives (PRD §2, §11).
// Timestamps are stored UTC (ISO strings) and rendered IST; business dates are
// "YYYY-MM-DD" in IST. All arithmetic is epoch +5.5h — no Date tz surprises.

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Current instant as ISO UTC. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** UC timestamps are epoch millis → ISO UTC (undefined for absent/zero). */
export function isoFromEpochMs(ms?: number | null): string | undefined {
  if (!ms || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * eShipz dates -> ISO UTC. Three shapes arrive on this one field:
 *   polling  RFC-1123 GMT  "Tue, 28 Jun 2022 13:58:26 GMT"
 *   webhook  ISO           "2026-09-12T10:03:11Z"
 *   self-delivery rows     "12-09-2026"  (DD-MM-YYYY, IST wall clock)
 *
 * The third is why this is not a bare Date.parse any more. V8 reads
 * "12-09-2026" as MM-DD-YYYY and returns 9 December — so a shipment delivered
 * on 12 September was stored with deliveredDate 2026-12-09, which is in the
 * FUTURE, and a future delivery date never ages off the In-Transit board
 * (daysBetween is negative, and the board keeps anything <= 2 days old). Live:
 * 11 orders pinned to the board, and 18 courier EDDs landing before their own
 * order date. Both callers below (delivery_date, expected_delivery_date) and
 * every checkpoint date run through here, so the guard belongs here rather
 * than at any one of them.
 *
 * A two-digit month > 12 cannot be DD-MM, so that falls through to Date.parse
 * rather than being dropped. The explicit +05:30 replaces a dependence on the
 * server's own timezone: these are IST wall-clock dates, and a container that
 * boots in UTC must not read them a day early.
 */
const DMY = /^([0-9]{2})[-/]([0-9]{2})[-/]([0-9]{4})(?:[T ]([0-9]{2}:[0-9]{2}(?::[0-9]{2})?))?/;

export function isoFromRfc1123(s?: string | null): string | undefined {
  if (!s) return undefined;
  const m = s.trim().match(DMY);
  if (m && Number(m[2]) <= 12) {
    const t = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4] ?? "00:00:00"}+05:30`);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function isoFromIstNtz(s?: string | null): string | undefined {
  if (!s) return undefined;
  const m = s
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[T ]?(\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?/);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2] ?? "00:00:00"}Z`);
  if (Number.isNaN(t)) return undefined;
  return new Date(t - IST_OFFSET_MS).toISOString();
}

/** Snowflake DATE values ("YYYY-MM-DD" in the IST session) → IST business date. */
export function istDateFromNtz(s?: string | null): string | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

/** IST business date (YYYY-MM-DD) for a UTC instant. */
export function istDateOf(iso: string | Date): string {
  const t = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's IST business date. */
export function istToday(): string {
  return istDateOf(new Date());
}

/** Parse a business date into the epoch of IST midnight of that day. */
export function istMidnightMs(businessDate: string): number {
  return Date.parse(`${businessDate}T00:00:00.000Z`) - IST_OFFSET_MS;
}

/** businessDate + n days. */
export function addDays(businessDate: string, n: number): string {
  return new Date(istMidnightMs(businessDate) + IST_OFFSET_MS + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Whole days from a → b (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((istMidnightMs(b) - istMidnightMs(a)) / DAY_MS);
}

/** Day-of-week (Mon..Sun) of a business date. */
export function weekdayOf(businessDate: string): "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun" {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  return names[new Date(istMidnightMs(businessDate) + IST_OFFSET_MS).getUTCDay()] as
    | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
}

/** ISO instant for a business date at an IST wall-clock cutoff like "11AM" / "2:30PM" / "16:00". */
export function atIstCutoff(businessDate: string, cutoff?: string): string {
  let hours = 23;
  let minutes = 59;
  if (cutoff) {
    const m = cutoff.trim().toUpperCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
    if (m) {
      hours = parseInt(m[1], 10) % 12;
      minutes = m[2] ? parseInt(m[2], 10) : 0;
      if (m[3] === "PM") hours += 12;
      if (!m[3]) hours = parseInt(m[1], 10); // 24h form
    }
  }
  return new Date(istMidnightMs(businessDate) + (hours * 60 + minutes) * 60 * 1000).toISOString();
}

const IST_FMT_DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
});
const IST_FMT_DATETIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "28 Jun" — for business dates or instants. */
export function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const t = v.length === 10 ? istMidnightMs(v) + IST_OFFSET_MS : Date.parse(v);
  if (Number.isNaN(t)) return "—";
  return IST_FMT_DATE.format(new Date(v.length === 10 ? t : t));
}

/** "28 Jun, 3:42 pm" IST. */
export function fmtDateTime(v?: string | null): string {
  if (!v) return "—";
  const t = Date.parse(v);
  if (Number.isNaN(t)) return "—";
  return IST_FMT_DATETIME.format(new Date(t));
}

/** Relative label for dashboards: "today" / "yesterday" / "3d ago" / "in 2d". */
export function fmtRelative(businessDate?: string | null): string {
  if (!businessDate) return "—";
  const d = daysBetween(istToday(), businessDate);
  if (d === 0) return "today";
  if (d === -1) return "yesterday";
  if (d === 1) return "tomorrow";
  return d < 0 ? `${-d}d ago` : `in ${d}d`;
}
