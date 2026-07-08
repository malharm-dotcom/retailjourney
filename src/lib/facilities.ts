// Facility display constants — plain module (NO "use client") so both server
// and client components get the real values, not a client-reference proxy.

import type { Facility } from "./types";

export const FACILITY_SHORT: Record<Facility, string> = {
  "SAPL-NORTH-TAURU": "North",
  "SAPL-WH1": "WH-1",
  "SAPL-WH2": "WH-2",
};
