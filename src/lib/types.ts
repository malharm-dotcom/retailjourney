// Domain types — mirror of the Prisma sketch in PRD §5 so M2 is a schema drop-in.
// Timestamps are ISO-8601 UTC strings; business dates are "YYYY-MM-DD" in IST.

export const FACILITIES = ["SAPL-NORTH-TAURU", "SAPL-WH1", "SAPL-WH2"] as const;
export type Facility = (typeof FACILITIES)[number];
export type FacilityScope = Facility | "ALL";

export type OrderType = "FRESH" | "RPL" | "Q_COMM" | "ACC" | "NON_TRADING" | "OTHER";
export type Channel = "FRANCHISE_STORE" | "OWN_STORE";
/** MFC = quick-commerce micro-fulfilment centre (normal store, normal rulebook
 *  lookup). SUVIDHA = external Suvidha-branded destination (tracked like a
 *  franchise store). */
export type Ownership = "COCO" | "FOCO" | "COFO" | "MFC" | "SUVIDHA";
export type Zone = "NORTH" | "WEST" | "SOUTH" | "EAST" | "UNMAPPED";

export type OrderStatus =
  | "NOT_STARTED"
  | "PICKING"
  | "PACKING"
  | "ON_HOLD"
  | "READY_TO_DISPATCH"
  | "RTS_LOGIC"
  | "DISPATCHED_TO_STORE"
  | "CANCELLED"
  | "UNFULFILLABLE";

export type OverallStatus = "WH_PROCESSING" | "PICKUP_PENDING" | "IN_TRANSIT" | "DELIVERED";

export type ShipmentStatus =
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "DELIVERY_FAILED"
  | "RETURN"; // cancelled / RTO — a dead label, excluded from the order rollup

export type ReceiptStatus = "RECEIVED" | "INWARDED" | "CLOSED";

export type EntryStatus = "OPEN" | "CLOSED";
export type Source = "SYNCED" | "SYNCED_SNOWFLAKE" | "MANUAL";

export type Role =
  | "ADMIN"
  | "MERCHANDISING"
  | "WH_SUPERVISOR"
  | "WH_OPERATOR"
  | "LOGISTICS"
  | "RETAIL_HEAD";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Facilities this user may scope to. ADMIN/MERCH/LOGISTICS/RETAIL_HEAD get all. */
  facilities: Facility[];
  /** Whether the "All facilities" union view is available. */
  allView: boolean;
  /** Retail Head / AM scoping — restricts reads to own stores when set. */
  areaManager?: string;
  active: boolean;
}

/** One eShipz tracking checkpoint (latest N stored on the order). */
export interface TrackingCheckpoint {
  city?: string;
  state?: string;
  date: string; // ISO UTC
  remark?: string;
  tag?: string;
  subtag?: string;
}

export interface OrderEvent {
  id: string;
  orderId: string;
  field: string; // "status" | "shipmentStatus" | any mutable field
  fromValue: string | null;
  toValue: string;
  source: Source;
  actorId: string | null; // null = system / API sync
  actorName?: string;
  note?: string;
  createdAt: string;
}

export interface Order {
  id: string;
  soNumber: string; // SO_NUMBER / ORDER_NAME — the spine key
  orderDate: string; // YYYY-MM-DD (IST)
  orderTimestamp: string;
  facility: Facility;
  channel: Channel;
  storeId: string;
  storeNameFormat: string;
  finalStore: string; // "SNITCH - FOCO - BOPAL"
  ownership?: Ownership;
  state: string;
  zone: Zone;
  type: OrderType;
  qty: number;
  priority?: string;
  campaignTag?: string; // REMARKS e.g. "YUVRAJ - SUMMER CAPSULE"
  merchandiser?: string;
  areaManager?: string;
  category?: string;

  // Phase A — WH processing + UC lifecycle
  status: OrderStatus;
  statusSource: Source;
  overallStatus: OverallStatus;
  ucStatus?: string;
  createdTs?: string;
  pickingTs?: string;
  pickedTs?: string;
  packedTs?: string;
  rtsTs?: string;
  manifestedTs?: string;
  dispatchedTs?: string;
  shippedTs?: string;
  deliveredTs?: string;
  cancelledTs?: string;
  weightKg?: number;
  pickedQty?: number;
  fulfilledQty?: number;
  unfulfillableQty?: number;
  boxCount?: number;
  saleInvoiceNumber?: string;
  rtsLogicDate?: string; // YYYY-MM-DD

  // Handoff
  dcNumber?: string;
  lrNumber?: string;
  logisticsPartner?: string; // MUDITACARGO | MOVEMATE | BLUEDART | EKART B2B | SELF
  courierPartner?: string;
  vehicleNumber?: string;
  eWayBill?: string;
  rtdDate?: string; // YYYY-MM-DD
  dispatchedDate?: string; // YYYY-MM-DD
  dispatchType?: string; // PTL ...
  laneClassification?: string;

  // Phase B — shipment (eShipz)
  shipmentStatus?: ShipmentStatus;
  shipmentSource?: Source;
  eshipStatus?: string;
  trackingNumber?: string;
  trackingStatus?: string;
  trackingSubStatus?: string;
  trackingLatestLocation?: string;
  trackingLatestMessage?: string;
  lastCheckpointCity?: string;
  lastCheckpointState?: string;
  trackingLink?: string;
  podLink?: string;
  expectedDate?: string; // YYYY-MM-DD (courier EDD)
  deliveredDate?: string; // YYYY-MM-DD
  deliveryAttempts: number;
  pickupAttempts: number;
  firstOfdDate?: string;
  latestOfdDate?: string;
  newLrNo?: string;
  logisticsComments?: string;
  /** Latest N eShipz checkpoints for the Journey tracking panel (M2 sync). */
  checkpoints?: TrackingCheckpoint[];

  // Phase C — inward / reconciliation
  receiptStatus?: ReceiptStatus;
  orderReceivedDate?: string; // YYYY-MM-DD
  boxesReceived?: number;
  totalCount?: number;
  inwardedDate?: string; // YYYY-MM-DD
  stiBillNo?: string;
  receivingPv?: string;
  shortageQty?: number;
  excessQty?: number;
  shortageExcessFileUrl?: string;
  adjustmentOnLogic?: boolean;
  entryStatus?: EntryStatus;

  // Snowflake distribution_analytics — spine enrichment (source SYNCED_SNOWFLAKE)
  receiverCity?: string;
  receiverState?: string;
  receiverPostalCode?: string;
  sales30d?: number;
  storeRank?: number;
  bestTat?: number;

  // Deadlines/TAT — Snowflake sole authority; only manual overrides
  targetOrderDay?: string;
  targetOrderCutoff?: string;
  targetHandoverDay?: string;
  targetHandoverCutoff?: string;
  targetPickupDay?: string;
  targetDeliveryDay?: string;
  orderCutoffTs?: string; // ISO UTC
  handoverDeadlineTs?: string; // ISO UTC
  pickupTat?: string; // ISO UTC — pickup deadline
  idealDeliveryDate?: string; // YYYY-MM-DD
  deliveryTat?: string; // ISO UTC — delivery deadline

  // Phase-A SLA — Snowflake seeds, app recomputes against actuals every sync
  orderPlacementSla?: string;
  handoverSla?: string;

  /** finalStore of the parent whose TAT this order inherited (QC stores). */
  tatInheritedFrom?: string;

  /** Field names last written MANUAL — sync never overwrites these (manual wins). */
  manualFields?: string[];

  createdAt: string;
  updatedAt: string;
}

/** One physical shipment (AWB) of an order — 0..n per order, 2+ on a split
 *  dispatch. Unique on (soNumber, awb). */
export interface OrderShipment {
  id: string;
  soNumber: string;
  awb: string;
  courier?: string;
  /** FALSE for self-delivery/porter pseudo-AWBs — the eShipz poller skips these. */
  isPollable: boolean;
  shipmentStatus?: ShipmentStatus;
  eshipStatus?: string;
  logisticsCreatedTs?: string; // ISO UTC
  trackingPickTs?: string;
  deliveredTs?: string;
  expectedDeliveryDate?: string; // YYYY-MM-DD
  firstOfdTs?: string;
  latestOfdTs?: string;
  deliveryAttempts?: number;
  pickupAttempts?: number;
  trackingLink?: string;
  trackingStatus?: string;
  trackingSubStatus?: string;
  trackingLatestLocation?: string;
  trackingLatestMessage?: string;
  lastCheckpointCity?: string;
  lastCheckpointState?: string;
  lastCheckpointRemark?: string;
  lastCheckpointSubtag?: string;
  lastCheckpointTag?: string;
  podLink?: string;
  packageCount?: number;
  pickupSla?: string;
  deliverySla?: string;
  logisticsDeliverySla?: string;
  perfectOrderSla?: string;
  source: string; // SNOWFLAKE | ESHIPZ | MANUAL
  createdAt: string;
  lastSyncedAt: string;
}

export interface Store {
  id: string;
  /** Physical-location code — a QC store shares its parent's branchCode. */
  branchCode: string;
  /** Quick-commerce outlet run from the parent store sharing its branchCode;
   *  its orders inherit the parent's TAT when Snowflake carries none. */
  isQuickCommerce: boolean;
  storeName: string; // "COFO - DAHISAR"
  finalStore: string; // "SNITCH - COFO - DAHISAR"
  ownership: Ownership;
  channel: Channel;
  storeCity: string;
  storeState: string;
  zone: Zone;
  facility: Facility; // serving WH
  areaManager?: string;
  merchandiser?: string;
  rank?: number;
  sales30d?: number;
  /** UC `channel` value that identifies this store on B2B retail orders (M2 sync). */
  channelCode?: string;
}

export interface RulebookEntry {
  id: string;
  storeId: string;
  orderType: OrderType;
  laneClassification?: string;
  zone?: Zone;
  bestTatDays?: number;
  targetOrderDay?: Weekday;
  targetOrderCutoff?: string; // "11AM"
  targetHandoverDay?: Weekday;
  targetHandoverCutoff?: string;
  targetPickupDay?: Weekday;
  targetDeliveryDay?: Weekday;
  effectiveFrom: string; // YYYY-MM-DD, versioned monthly
  effectiveTo?: string;
}

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export const WEEKDAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const LOGISTICS_PARTNERS = [
  "MUDITACARGO",
  "MOVEMATE",
  "BLUEDART",
  "EKART B2B",
  "SELF",
] as const;

export const LANES = [
  "Milk Run Lane",
  "Dedicated Vehicle Lane",
  "Dedicated PTL Partner Lane",
  "North-1",
  "West-2",
  "East-2",
  "South-1",
  "South-3",
  "Central",
] as const;
