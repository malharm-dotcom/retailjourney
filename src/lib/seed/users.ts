// Seed users / demo personas (PRD §3). In M1 the dev credentials provider signs
// in as any of these; from M5 the same records gate Google SSO activation.

import type { User } from "../types";

export const USERS: User[] = [
  {
    id: "u_malhar",
    name: "Malhar M",
    email: "malhar.m@snitch.com",
    role: "ADMIN",
    facilities: [],
    allView: true,
    active: true,
  },
  {
    id: "u_maddy",
    name: "Maddy (Mahadevan Pillai)",
    email: "mahadevan.p@snitch.com",
    role: "ADMIN",
    facilities: [],
    allView: true,
    active: true,
  },
  {
    id: "u_yuvraj",
    name: "Yuvraj",
    email: "yuvraj@snitch.com",
    role: "MERCHANDISING",
    facilities: [],
    allView: true,
    active: true,
  },
  {
    id: "u_priyanka",
    name: "Priyanka",
    email: "priyanka@snitch.com",
    role: "MERCHANDISING",
    facilities: [],
    allView: true,
    active: true,
  },
  {
    id: "u_anish",
    name: "Anish",
    email: "anish@snitch.com",
    role: "MERCHANDISING",
    facilities: [],
    allView: true,
    active: true,
  },
  {
    id: "u_srushti",
    name: "Srushti",
    email: "srushti@snitch.com",
    role: "MERCHANDISING",
    facilities: [],
    allView: true,
    active: true,
  },
  {
    id: "u_whsup_blr",
    name: "Ravi Kumar",
    email: "ravi.k@snitch.com",
    role: "WH_SUPERVISOR",
    facilities: ["SAPL-WH1", "SAPL-WH2"],
    allView: false,
    active: true,
  },
  {
    id: "u_whsup_north",
    name: "Deepak Sharma",
    email: "deepak.s@snitch.com",
    role: "WH_SUPERVISOR",
    facilities: ["SAPL-NORTH-TAURU"],
    allView: false,
    active: true,
  },
  {
    id: "u_whop_wh1",
    name: "Suresh (Picker, WH-1)",
    email: "suresh@snitch.com",
    role: "WH_OPERATOR",
    facilities: ["SAPL-WH1"],
    allView: false,
    active: true,
  },
  {
    id: "u_logistics",
    name: "Logistics Desk",
    email: "logistics@snitch.com",
    role: "LOGISTICS",
    facilities: [],
    allView: true,
    active: true,
  },
  {
    id: "u_sonit",
    name: "Sonit Tandon",
    email: "sonit.t@snitch.com",
    role: "RETAIL_HEAD",
    facilities: [],
    allView: true,
    areaManager: "Sonit Tandon",
    active: true,
  },
  {
    id: "u_sasmit",
    name: "Sasmit",
    email: "sasmit@snitch.com",
    role: "RETAIL_HEAD",
    facilities: [],
    allView: true,
    areaManager: "Sasmit",
    active: true,
  },
  {
    id: "u_subham",
    name: "Subham",
    email: "subham@snitch.com",
    role: "RETAIL_HEAD",
    facilities: [],
    allView: true,
    areaManager: "Subham",
    active: true,
  },
  {
    id: "u_kuldeep",
    name: "Kuldeep",
    email: "kuldeep@snitch.com",
    role: "RETAIL_HEAD",
    facilities: [],
    allView: true,
    areaManager: "Kuldeep",
    active: true,
  },
];

export function userById(id: string): User | undefined {
  return USERS.find((u) => u.id === id);
}

export function userByEmail(email: string): User | undefined {
  return USERS.find((u) => u.email.toLowerCase() === email.toLowerCase());
}
