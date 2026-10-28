// Vendored from https://github.com/milan2307/east-africa-phone-normaliser/blob/bb44cf4/src/core/plans.ts (MIT, LamuLabs). Do not edit here.
/**
 * Official numbering-plan data for Kenya (+254), Uganda (+256) and Tanzania (+255).
 * Every row comes from the regulator's own published plan; see SOURCES. Nothing here comes from a live
 * registry: "network" means the operator the number RANGE is allocated to, not the subscriber's current
 * network (numbers can be ported between operators).
 */

export type Country = "KE" | "UG" | "TZ";
export type NumberType = "mobile" | "landline" | "m2m" | "toll_free" | "premium";

export type Allocation = {
  /** Leading digits of the national significant number (NSN, no trunk 0, no country code). */
  prefix: string;
  type: NumberType;
  /** Operator legal name as written in the plan. */
  operator: string | null;
  /** Everyday brand, when it differs (e.g. Honora Tanzania PLC trades as Yas). */
  brand: string | null;
  /** NSN length bounds from the plan. */
  minLength: number;
  maxLength: number;
  status?: "operational" | "not_operational" | "test_only" | "special_use" | "secondary_source";
  region?: string;
  note?: string;
};

export const SOURCES: Record<Country, { plan: string; url: string; retrieved: string }> = {
  KE: {
    plan: "Communications Authority of Kenya, Telecommunication Numbering Plan for Kenya, April 2026 (CA/SRM/S&N/NNP/APRIL/2026)",
    url: "https://www.ca.go.ke/sites/default/files/2026-04/Numbering%20Plan%20Kenya%20April%202026.pdf",
    retrieved: "2026-10-28",
  },
  UG: {
    plan: "Uganda Communications Commission, National Numbering Plan of Uganda, as notified to the ITU on 13 July 2026",
    url: "https://www.itu.int/dms_pub/itu-t/oth/02/02/T02020000F10016PDFE.pdf",
    retrieved: "2026-10-28",
  },
  TZ: {
    plan: "Tanzania Communications Regulatory Authority, National Numbering and Signalling Point Codes Plans, July 2025",
    url: "https://www.tcra.go.tz/tcra-tovuti/2025/mamlaka-website/documents/communication-sector-guidbooks-and-plans/en_1751634705_National_Numbering_and_Signaling_Point_Code_Plans_edition_of_2025_f06646e5f3.pdf",
    retrieved: "2026-10-28",
  },
};

/**
 * Ranges that Google's libphonenumber (release 9.0.42, carrier data updated 2026-10-22) lists as allocated but that the
 * latest official plan we could find does not list yet. Treated as valid but flagged, so real numbers are not rejected
 * while the regulator's published plan catches up.
 */
export const SECONDARY_SOURCE = {
  plan: "Google libphonenumber carrier data, release 9.0.42 (not in the latest published regulator plan)",
  url: "https://github.com/google/libphonenumber/tree/master/resources/carrier/en",
};

export const COUNTRY_CODES: Record<Country, string> = { KE: "254", UG: "256", TZ: "255" };

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
const mob = (prefixes: string[], operator: string, brand: string | null, extra: Partial<Allocation> = {}): Allocation[] =>
  prefixes.map((prefix) => ({ prefix, type: "mobile", operator, brand, minLength: 9, maxLength: 9, status: "operational", ...extra }));

// ---------------------------------------------------------------- Kenya (CA, April 2026, section 1.1-1.3)
const SAF = "Safaricom PLC", AIRTEL_KE = "Airtel Networks Kenya Ltd", TELKOM = "Telkom Kenya Ltd";
const KE_FIXED: [string, number, string][] = [
  ["20", 8, "Nairobi City"],
  ["40", 8, "Kwale, Ukunda, Msambweni, Lungalunga"],
  ["41", 9, "Mombasa, Mariakani, Kilifi"],
  ["42", 7, "Malindi, Lamu, Garsen"],
  ["43", 9, "Voi, Taveta, Wundanyi, Mwatate"],
  ["44", 7, "Machakos, Makueni, Kitui, Mwingi"],
  ["45", 7, "Ngong, Kajiado, Loitokitok, Athi River"],
  ["46", 9, "Garissa, Hola, Wajir, Mandera"],
  ["50", 9, "Naivasha, Gilgil, Narok"],
  ["51", 8, "Nakuru, Njoro, Molo"],
  ["52", 7, "Kericho, Bomet"],
  ["53", 7, "Eldoret, Turbo, Kapsabet, Iten, Kabarnet"],
  ["54", 7, "Kitale, Moisbridge, Kapenguria, Lodwar"],
  ["55", 7, "Bungoma, Busia"],
  ["56", 7, "Kakamega, Butere, Mbale, Mumias"],
  ["57", 7, "Kisumu, Maseno, Siaya"],
  ["58", 9, "Kisii, Kilgoris, Oyugis, Nyamira"],
  ["59", 7, "Homabay, Migori"],
  ["60", 7, "Muranga, Kirinyaga"],
  ["61", 7, "Nyeri, Karatina"],
  ["62", 9, "Nanyuki"],
  ["64", 7, "Meru, Maua, Chuka"],
  ["66", 8, "Thika, Ruiru"],
  ["67", 7, "Kiambu, Kikuyu"],
  ["68", 9, "Embu"],
  ["69", 7, "Marsabit, Moyale"],
];
export const KENYA: Allocation[] = [
  ...mob(range(100, 108), AIRTEL_KE, "Airtel"),
  ...mob(range(110, 119), SAF, "Safaricom"),
  ...mob(["120"], "Jambo Telcoms Ltd", null),
  ...mob(["124"], "Infura Ltd", null),
  ...mob(["126"], "Hidiga Investments Ltd", null),
  ...mob(["128"], "Webtribe Ltd", null),
  ...mob(["130"], "NRG Media Ltd", null),
  ...mob(range(135, 139), AIRTEL_KE, "Airtel", { status: "secondary_source", note: "Listed as Airtel by libphonenumber 9.0.42; not in the CA April 2026 plan" }),
  ...mob(range(140, 146), SAF, "Safaricom"),
  ...mob(["18"], SAF, "Safaricom", { status: "secondary_source", note: "Listed as Safaricom by libphonenumber 9.0.42; not in the CA April 2026 plan" }),
  ...mob(["199"], "Shared resource", null, { status: "test_only", note: "Reserved for network testing, experimentation and research; not issued to subscribers" }),
  ...mob(range(700, 729), SAF, "Safaricom"),
  ...mob(range(730, 739), AIRTEL_KE, "Airtel"),
  ...mob(range(740, 743), SAF, "Safaricom"),
  ...mob(["744"], "Homelands Media Ltd", null),
  ...mob(range(745, 746), SAF, "Safaricom"),
  ...mob(["747"], "Jamii Telecoms Ltd", null),
  ...mob(["748"], SAF, "Safaricom"),
  ...mob(["749"], "IEBC", null, { status: "special_use", note: "Assigned for use by the IEBC in KIEMS kits" }),
  ...mob(range(750, 756), AIRTEL_KE, "Airtel"),
  ...mob(range(757, 759), SAF, "Safaricom"),
  ...mob(["760"], "Mobile Pay Ltd", null),
  ...mob(["761"], "Eferio Kenya Ltd", null),
  ...mob(["762"], AIRTEL_KE, "Airtel"),
  ...mob(range(763, 766), "Finserve Africa Ltd", "Equitel"),
  ...mob(range(768, 769), SAF, "Safaricom"),
  ...mob(range(770, 779), TELKOM, "Telkom"),
  ...mob(range(780, 789), AIRTEL_KE, "Airtel"),
  ...mob(range(790, 799), SAF, "Safaricom"),
  ...KE_FIXED.map(([prefix, minLength, region]): Allocation => ({ prefix, type: "landline", operator: null, brand: null, minLength, maxLength: 9, region, note: "Geographic fixed-line area code; the plan does not tie it to one operator" })),
  { prefix: "300", type: "m2m", operator: null, brand: null, minLength: 12, maxLength: 12, note: "Machine-to-machine / IoT numbers, not for people" },
  { prefix: "800", type: "toll_free", operator: null, brand: null, minLength: 9, maxLength: 9 },
  { prefix: "900", type: "premium", operator: null, brand: null, minLength: 9, maxLength: 9 },
];

// ---------------------------------------------------------------- Uganda (UCC via ITU, 13 July 2026). All NSNs are 9 digits.
const AIRTEL_UG = "Airtel Uganda Limited", MTN_UG = "MTN Uganda Limited", UTL = "Uganda Telecommunications Corporation Limited";
const ugFixed = (prefixes: string[], operator: string, brand: string | null): Allocation[] =>
  prefixes.map((prefix) => ({ prefix, type: "landline", operator, brand, minLength: 9, maxLength: 9, status: "operational" }));
export const UGANDA: Allocation[] = [
  ...ugFixed(["200", "201", "207"], AIRTEL_UG, "Airtel"),
  ...ugFixed(["20240"], "Liquid Intelligent Technologies", null),
  ...ugFixed(["20249"], "Blue Crane Communications (U) Limited", null),
  ...ugFixed(["2031"], "Talkio Mobile Limited", null),
  ...ugFixed(["2032"], "Echotel Proprietary Uganda Limited", null),
  ...ugFixed(["2050", "2051", "2052", "2053", "2054"], "Roke Telkom Limited", null),
  ...ugFixed(["20611"], "Hamilton Telecom Limited", null),
  ...ugFixed(["206300", "206301", "206302", "206303", "206304"], "Simbanet Uganda Limited", null),
  ...ugFixed(["3"], MTN_UG, "MTN"),
  ...ugFixed(["4"], UTL, "Uganda Telecom"),
  ...mob(range(700, 709), AIRTEL_UG, "Airtel"),
  ...mob(range(710, 719), UTL, "Uganda Telecom"),
  ...mob(["7210"], "Savanna Fibre Limited", null),
  ...mob(["724"], "Hamilton Telecom Limited", null),
  ...mob(["726", "727"], "Tangerine Limited", null),
  ...mob(["7280"], "Talkio Mobile Limited", null),
  ...mob(["730", "731"], AIRTEL_UG, "Airtel"),
  ...mob(["732"], AIRTEL_UG, "Airtel", { status: "secondary_source", note: "Listed as Airtel by libphonenumber 9.0.42; not in the UCC July 2026 plan" }),
  ...mob(["736"], "Hamilton Telecom Limited", null, { status: "secondary_source", note: "Listed as Hamilton Telecom by libphonenumber 9.0.42; not in the UCC July 2026 plan" }),
  ...mob(["7340"], "Roke Telkom Limited", null),
  ...mob(["7370", "7371"], "Blue Crane Communications (U) Limited", null),
  ...mob(range(740, 759), AIRTEL_UG, "Airtel"),
  ...mob(range(760, 789), MTN_UG, "MTN"),
  ...mob(range(790, 795), MTN_UG, "MTN"),
];

// ---------------------------------------------------------------- Tanzania (TCRA, July 2025, Tables 3, 7 and 10)
const TZ_AREAS: [string, string][] = [
  ["22", "Dar es Salaam"],
  ["23", "Coast, Lindi, Morogoro, Mtwara"],
  ["24", "Zanzibar (Pemba and Unguja)"],
  ["25", "Katavi, Mbeya, Rukwa, Ruvuma, Songwe"],
  ["26", "Dodoma, Iringa, Njombe, Singida, Tabora"],
  ["27", "Arusha, Kilimanjaro, Manyara, Tanga"],
  ["28", "Geita, Kagera, Kigoma, Mara, Mwanza, Shinyanga, Simiyu"],
];
const TTCL = "Tanzania Telecommunications Corporation", HONORA = "Honora Tanzania PLC";
export const TANZANIA: Allocation[] = [
  ...mob(["61"], "Viettel Tanzania PLC", "Halotel"),
  ...mob(["62"], "Viettel Tanzania PLC", "Halotel", { status: "not_operational", note: "Allocated but listed as not operational by TCRA" }),
  ...mob(["65", "67", "71", "77"], HONORA, "Yas", { note: "Yas is the brand of Honora Tanzania PLC (formerly Tigo; Zantel merged in)" }),
  ...mob(["68", "69", "78"], "Airtel Tanzania PLC", "Airtel"),
  ...mob(["74", "75", "76", "79"], "Vodacom Tanzania PLC", "Vodacom"),
  ...mob(["73"], TTCL, "TTCL"),
  ...mob(["60", "66"], "Airtel Tanzania PLC", "Airtel", { status: "secondary_source", note: "Listed as Airtel by libphonenumber 9.0.42; TCRA July 2025 lists this code as reserved" }),
  ...mob(["70"], HONORA, "Yas", { status: "secondary_source", note: "Listed as Yas by libphonenumber 9.0.42; TCRA July 2025 lists 070 as reserved for mobile operators" }),
  ...mob(["72"], "Vodacom Tanzania PLC", "Vodacom", { status: "secondary_source", note: "Listed as Vodacom by libphonenumber 9.0.42; TCRA July 2025 lists 072 as reserved for mobile operators" }),
  ...mob(["63"], "Viettel Tanzania PLC", "Halotel", { status: "secondary_source", note: "Listed as Viettel by libphonenumber 9.0.42; TCRA July 2025 lists this code as reserved" }),
  // PSTN format 02A Y XXXXXX: Y=2 TTCL, Y=5 Honora (Table 10).
  ...TZ_AREAS.flatMap(([area, region]): Allocation[] => [
    { prefix: `${area}2`, type: "landline", operator: TTCL, brand: "TTCL", minLength: 9, maxLength: 9, region, status: "operational" },
    { prefix: `${area}5`, type: "landline", operator: HONORA, brand: "Yas", minLength: 9, maxLength: 9, region, status: "operational" },
  ]),
  { prefix: "800", type: "toll_free", operator: null, brand: null, minLength: 9, maxLength: 9 },
  { prefix: "90", type: "premium", operator: null, brand: null, minLength: 9, maxLength: 9 },
];

export const PLANS: Record<Country, Allocation[]> = { KE: KENYA, UG: UGANDA, TZ: TANZANIA };

/** Longest-prefix match. */
export function lookup(country: Country, nsn: string): Allocation | undefined {
  let best: Allocation | undefined;
  for (const a of PLANS[country]) if (nsn.startsWith(a.prefix) && (!best || a.prefix.length > best.prefix.length)) best = a;
  return best;
}
