// Rulebook seed (PRD §7) — per store × order-type weekly schedule, versioned
// monthly like the real Apr/May/Jun republish cadence. Lane/zone patterns per §13.

import type { OrderType, RulebookEntry, Weekday, Zone } from "../types";
import { STORES } from "./stores";

// Weekly patterns per zone: [orderDay, orderCutoff, handoverDay, handoverCutoff, pickupDay, deliveryDay, bestTat, lane]
type Pattern = [Weekday, string, Weekday, string, Weekday, Weekday, number, string];

const FRESH_PATTERNS: Record<Zone, Pattern> = {
  NORTH: ["Mon", "11AM", "Tue", "6PM", "Wed", "Fri", 4, "North-1"],
  WEST: ["Mon", "11AM", "Tue", "6PM", "Wed", "Sat", 5, "Dedicated Vehicle Lane"],
  SOUTH: ["Tue", "11AM", "Wed", "6PM", "Thu", "Fri", 3, "Milk Run Lane"],
  EAST: ["Tue", "11AM", "Wed", "6PM", "Thu", "Mon", 6, "East-2"],
  UNMAPPED: ["Mon", "11AM", "Wed", "6PM", "Thu", "Sat", 5, "Central"],
};

const RPL_PATTERNS: Record<Zone, Pattern> = {
  NORTH: ["Thu", "11AM", "Fri", "6PM", "Sat", "Mon", 4, "North-1"],
  WEST: ["Thu", "11AM", "Fri", "6PM", "Sat", "Tue", 5, "Dedicated PTL Partner Lane"],
  SOUTH: ["Fri", "11AM", "Sat", "6PM", "Sun", "Mon", 3, "Milk Run Lane"],
  EAST: ["Fri", "11AM", "Sat", "6PM", "Sun", "Thu", 6, "East-2"],
  UNMAPPED: ["Thu", "11AM", "Sat", "6PM", "Sun", "Tue", 5, "Central"],
};

const OTHER_PATTERNS: Record<Zone, Pattern> = {
  NORTH: ["Wed", "2PM", "Thu", "6PM", "Fri", "Sun", 4, "North-1"],
  WEST: ["Wed", "2PM", "Thu", "6PM", "Fri", "Mon", 5, "West-2"],
  SOUTH: ["Wed", "2PM", "Thu", "6PM", "Fri", "Sat", 3, "South-1"],
  EAST: ["Wed", "2PM", "Thu", "6PM", "Fri", "Tue", 6, "East-2"],
  UNMAPPED: ["Wed", "2PM", "Fri", "6PM", "Sat", "Mon", 5, "Central"],
};

const TYPES: [OrderType, Record<Zone, Pattern>][] = [
  ["FRESH", FRESH_PATTERNS],
  ["RPL", RPL_PATTERNS],
  ["OTHER", OTHER_PATTERNS],
];

/** Monthly versions — current one open-ended (matches the republish cadence). */
const VERSIONS: { from: string; to?: string }[] = [
  { from: "2026-05-01", to: "2026-05-31" },
  { from: "2026-06-01", to: "2026-06-30" },
  { from: "2026-07-01" },
];

function buildRules(): RulebookEntry[] {
  const rules: RulebookEntry[] = [];
  let n = 0;
  for (const v of VERSIONS) {
    for (const s of STORES) {
      for (const [orderType, patterns] of TYPES) {
        const p = patterns[s.zone];
        n += 1;
        rules.push({
          id: `rb_${String(n).padStart(4, "0")}`,
          storeId: s.id,
          orderType,
          laneClassification: p[7],
          zone: s.zone,
          bestTatDays: p[6],
          targetOrderDay: p[0],
          targetOrderCutoff: p[1],
          targetHandoverDay: p[2],
          targetHandoverCutoff: p[3],
          targetPickupDay: p[4],
          targetDeliveryDay: p[5],
          effectiveFrom: v.from,
          effectiveTo: v.to,
        });
      }
    }
  }
  return rules;
}

export const RULEBOOK: RulebookEntry[] = buildRules();

export const RULEBOOK_VERSIONS = VERSIONS;
