// Store master seed — names/zones/lanes/AMs lifted from the v2 prototype rows
// and the §13 vocabulary. ~30 stores across the three facilities.

import type { Ownership, Store, Zone, Facility } from "../types";

let n = 0;
function store(
  storeName: string,
  city: string,
  state: string,
  zone: Zone,
  facility: Facility,
  areaManager: string,
  merchandiser: string,
  sales30d: number,
): Store {
  n += 1;
  const ownership = storeName.split(" - ")[0] as Ownership;
  return {
    id: `st_${String(n).padStart(3, "0")}`,
    branchCode: `SN${String(100 + n)}`,
    isQuickCommerce: false,
    storeName,
    finalStore: `SNITCH - ${storeName}`,
    ownership,
    channel: ownership === "COCO" ? "OWN_STORE" : "FRANCHISE_STORE",
    storeCity: city,
    storeState: state,
    zone,
    facility,
    areaManager,
    merchandiser,
    rank: n,
    sales30d,
  };
}

export const STORES: Store[] = [
  // West — served by SAPL-WH1 (Bengaluru)
  store("COFO - DAHISAR", "Mumbai", "Maharashtra", "WEST", "SAPL-WH1", "Sasmit", "Priyanka", 4180000),
  store("COFO - LINKING ROAD", "Mumbai", "Maharashtra", "WEST", "SAPL-WH1", "Sasmit", "Priyanka", 6120000),
  store("COFO - COLABA", "Mumbai", "Maharashtra", "WEST", "SAPL-WH1", "Sasmit", "Priyanka", 3350000),
  store("COCO - PHOENIX PALLADIUM", "Mumbai", "Maharashtra", "WEST", "SAPL-WH1", "Sasmit", "Priyanka", 7240000),
  store("FOCO - BOPAL", "Ahmedabad", "Gujarat", "WEST", "SAPL-WH1", "Mahesh", "Priyanka", 2410000),
  store("FOCO - GANDHI NAGAR", "Gandhinagar", "Gujarat", "WEST", "SAPL-WH1", "Mahesh", "Priyanka", 2130000),
  store("COCO - FC ROAD", "Pune", "Maharashtra", "WEST", "SAPL-WH1", "Sasmit", "Priyanka", 3980000),
  store("COFO - VIMAN NAGAR", "Pune", "Maharashtra", "WEST", "SAPL-WH1", "Sasmit", "Priyanka", 2870000),

  // South — served by SAPL-WH2 (Bengaluru)
  store("COCO - KORAMANGALA", "Bengaluru", "Karnataka", "SOUTH", "SAPL-WH2", "Kuldeep", "Srushti", 8110000),
  store("COCO - INDIRANAGAR", "Bengaluru", "Karnataka", "SOUTH", "SAPL-WH2", "Kuldeep", "Srushti", 6890000),
  store("COFO - PONDY BAZAAR", "Chennai", "Tamil Nadu", "SOUTH", "SAPL-WH2", "Kuldeep", "Srushti", 3120000),
  store("COFO - ANNA NAGAR", "Chennai", "Tamil Nadu", "SOUTH", "SAPL-WH2", "Kuldeep", "Srushti", 2760000),
  store("FOCO - HITECH CITY", "Hyderabad", "Telangana", "SOUTH", "SAPL-WH2", "Kuldeep", "Srushti", 4450000),
  store("COCO - JUBILEE HILLS", "Hyderabad", "Telangana", "SOUTH", "SAPL-WH2", "Kuldeep", "Srushti", 5230000),
  store("FOCO - LULU MALL KOCHI", "Kochi", "Kerala", "SOUTH", "SAPL-WH2", "Kuldeep", "Srushti", 3640000),
  store("COFO - MG ROAD VIJAYAWADA", "Vijayawada", "Andhra Pradesh", "SOUTH", "SAPL-WH2", "Kuldeep", "Srushti", 1890000),

  // North — served by SAPL-NORTH-TAURU
  store("COCO - CREEK VILLAGE", "Gurugram", "Haryana", "NORTH", "SAPL-NORTH-TAURU", "Sonit Tandon", "Yuvraj", 5110000),
  store("COCO - AIRIA MALL", "Gurugram", "Haryana", "NORTH", "SAPL-NORTH-TAURU", "Subham", "Anish", 4720000),
  store("FOCO - MALVIYA NAGAR", "Jaipur", "Rajasthan", "NORTH", "SAPL-NORTH-TAURU", "Sonit Tandon", "Yuvraj", 2980000),
  store("COFO - KAROL BAGH", "New Delhi", "Delhi", "NORTH", "SAPL-NORTH-TAURU", "Sonit Tandon", "Yuvraj", 4390000),
  store("COCO - CONNAUGHT PLACE", "New Delhi", "Delhi", "NORTH", "SAPL-NORTH-TAURU", "Sonit Tandon", "Yuvraj", 7910000),
  store("FOCO - SECTOR 17", "Chandigarh", "Chandigarh", "NORTH", "SAPL-NORTH-TAURU", "Sonit Tandon", "Yuvraj", 2540000),
  store("COFO - HAZRATGANJ", "Lucknow", "Uttar Pradesh", "NORTH", "SAPL-NORTH-TAURU", "Subham", "Yuvraj", 2210000),
  store("FOCO - ELANTE MALL", "Chandigarh", "Chandigarh", "NORTH", "SAPL-NORTH-TAURU", "Sonit Tandon", "Yuvraj", 3050000),

  // East — served out of SAPL-WH2 in this seed
  store("COCO - RAIPUR", "Raipur", "Chhattisgarh", "EAST", "SAPL-WH2", "Subham", "Anish", 1980000),
  store("COFO - MAGNETO MALL", "Raipur", "Chhattisgarh", "EAST", "SAPL-WH2", "Subham", "Anish", 1720000),
  store("COCO - PARK STREET", "Kolkata", "West Bengal", "EAST", "SAPL-WH2", "Subham", "Anish", 4870000),
  store("FOCO - CITY CENTRE SALT LAKE", "Kolkata", "West Bengal", "EAST", "SAPL-WH2", "Subham", "Anish", 2660000),
  store("COFO - PATNA ONE MALL", "Patna", "Bihar", "EAST", "SAPL-WH2", "Subham", "Anish", 1540000),
  store("FOCO - GUWAHATI GS ROAD", "Guwahati", "Assam", "EAST", "SAPL-WH2", "Subham", "Anish", 1310000),
];

export function storeById(id: string): Store | undefined {
  return STORES.find((s) => s.id === id);
}
