require("dotenv").config();

// const dns = require("dns");
// try {
//   dns.setServers(["8.8.8.8", "1.1.1.1"]);
// } catch (_e) { }

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const OpenAI = require("openai");
const multer = require("multer");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4099;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGODB_URI = process.env.MONGODB_URI;

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["*"];

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads-private");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Temp dir for KB file uploads — files are deleted immediately after text extraction.
const KB_UPLOAD_DIR = path.join(__dirname, "kb-uploads-private");
if (!fs.existsSync(KB_UPLOAD_DIR)) fs.mkdirSync(KB_UPLOAD_DIR, { recursive: true });

const MAX_USER_TURNS_BEFORE_HANDOFF = parseInt(
  process.env.MAX_USER_TURNS_BEFORE_HANDOFF || "14",
  10
);

// Per-entry and total char caps to stay within GPT-4 context limits.
const KB_MAX_CHARS_PER_ENTRY = 100_000; // ~25 k tokens
const KB_MAX_TOTAL_CHARS = 400_000; // cumulative across all entries

const COMPANY = {
  legalName: "Test Drive Group Pty Ltd",
  tradingAs: "Buy My Next Car",
  abn: "51 679 064 343",
  acn: "679 064 343",
  companyType: "Australian Proprietary Company, Limited By Shares",
  registrationDate: "12/07/2024",
  status: "Registered",
  registeredOfficeLocality: "Rowville VIC 3178",
  regulator: "Australian Securities & Investments Commission (ASIC)",
  phone: "0440 130 476",
  email: "contact@buymynextcar.com.au",
};

const FINANCE_PARTNER = {
  legalName: "Acquired Financial Services Pty Ltd",
  tradingAs: "Acquired Finance",
  acl: "488607",           // Australian Credit Licence
  phone: "1300 235 255",
  website: "www.acquiredfinance.com",
  lenderPanel: "63+",
};

// ── Guard required env vars ──────────────────────────────────────────────────
if (!OPENAI_API_KEY) {
  console.error("[FATAL] OPENAI_API_KEY is not set.");
  process.exit(1);
}
if (!MONGODB_URI) {
  console.error("[FATAL] MONGODB_URI is not set. Add it to .env  e.g.  MONGODB_URI=mongodb+srv://...");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ── SMTP / Lead email ────────────────────────────────────────────────────────
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
const SMTP_SECURE = String(process.env.SMTP_SECURE).toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const LEAD_NOTIFY_FROM = process.env.LEAD_NOTIFY_FROM || SMTP_USER;
const LEAD_NOTIFY_EMAIL = (process.env.LEAD_NOTIFY_EMAIL || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

const SMTP_CONFIGURED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
const LEAD_EMAIL_READY = SMTP_CONFIGURED && LEAD_NOTIFY_EMAIL.length > 0;

let mailTransporter = null;
if (SMTP_CONFIGURED) {
  mailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  mailTransporter.verify().then(
    () => console.log("[Mail] SMTP verified — lead emails will send."),
    (err) => console.error("[Mail] SMTP verification failed:", err?.message || err)
  );
} else {
  console.warn("[Mail] SMTP not configured — lead emails will NOT send.");
}

// ── MobileMessage SMS ──────────────────────────────────────────────────────
const MOBILEMESSAGE_USERNAME = (process.env.MOBILEMESSAGE_USERNAME || "")
  .replace(/^"+|"+$/g, "")
  .trim();
const MOBILEMESSAGE_PASSWORD = (process.env.MOBILEMESSAGE_PASSWORD || "")
  .replace(/^"+|"+$/g, "")
  .trim();
const MOBILEMESSAGE_FROM = (process.env.MOBILEMESSAGE_FROM || "")
  .replace(/^"+|"+$/g, "")
  .trim();

const SMS_CONFIGURED = !!(MOBILEMESSAGE_USERNAME && MOBILEMESSAGE_PASSWORD);
if (SMS_CONFIGURED) {
  console.log(`[SMS] MobileMessage configured. Sender: "${MOBILEMESSAGE_FROM || "Default"}"`);
} else {
  console.warn("[SMS] MobileMessage credentials not set.");
}

// ─────────────────────────────────────────────────────────────────────────────
// MongoDB connection
// ─────────────────────────────────────────────────────────────────────────────

mongoose.set("strictQuery", true);

mongoose.connection.on("connected", () => console.log("[MongoDB] Connected to:", mongoose.connection.host));
mongoose.connection.on("error", (err) => console.error("[MongoDB] Connection error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("[MongoDB] Disconnected — will auto-reconnect."));

// ─────────────────────────────────────────────────────────────────────────────
// KnowledgeEntry Mongoose model
// ─────────────────────────────────────────────────────────────────────────────

const knowledgeEntrySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    label: { type: String, required: true, maxlength: 200 },
    text: { type: String, required: true },
    source: { type: String, enum: ["pdf", "txt", "free-text"], default: "free-text" },
    charCount: { type: Number, required: true },
  },
  {
    timestamps: { createdAt: "addedAt", updatedAt: false },
    collection: "knowledgeentries",
  }
);

const KnowledgeEntry = mongoose.model("KnowledgeEntry", knowledgeEntrySchema);

// ─────────────────────────────────────────────────────────────────────────────
// Built-in Knowledge Base: Tony White Group (TWG) + Autopact (AP) + BYD
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN_NETWORK_INDEX = `# Buy My Next Car: Tony White Group (TWG) + Autopact (AP) + BYD network index

Condensed from "Full Network List and Developer Handover". Source-review date for all records: 2 Oct 2026 (some pages may be cached). Not a live-stock, price or spec check.

## Rules for the AI (read first)
- This is a brand/model/range index only. It does NOT establish live stock, prices, grades, engines, fuel use, towing, service intervals, safety ratings or discounts. A row is not necessarily a distinct grade or stock vehicle.
- A group franchise listing is not a guarantee of commercial access, discount or availability. "Not verified" means not covered here, NOT unavailable in Australia.
- Record IDs: 4-digit ref [0051] = BMNC-NET-0051. Never alter IDs, brand names or model names. Keep status and source with each answer.
- Keep separate labels separate: Chevrolet (GMSV), GMC (GMSV), Isuzu UTE vs Isuzu Trucks, Mercedes-Benz vs Mercedes-Benz Trucks, Volvo Cars (no Volvo Trucks), Fiat Professional (vans only, no Fiat/Abarth cars). Do not infer one franchise from another.
- "Check exact grade", "Not verified" = missing info. Never guess specs. Never invent prices.
- New/demo/used condition, km, warranty start, price, availability need an actual dealer listing or quote. Do not calculate demo discounts.
- Do not store customer info or private dealer terms in the shared knowledge base. Customer corrections are reviewed before becoming shared facts.
- Cite recorded source IDs (register at the end) when stating network or range evidence.
- Pre-release tests: BYD Sealion 7, Zeekr 7X, Toyota via TWG, GMSV via Autopact, an upcoming model, Holden as legacy, unknown grade.

## Status codes
- (no tag) = RANGE_LISTED (424 rows): in reviewed Australian range material; stock, grades, new-order availability still need confirming.
- **A** = ANNOUNCED_OR_PREORDER (33): do not promise immediate supply.
- **L** = LEGACY_OR_STOCK (35): earlier/runout; do not call current factory production.
- **C** = CONFIRM_ORDER_STATUS (15): range page exists; local ordering needs dealer confirmation.

Abbreviations: TWG = Tony White Group, AP = Autopact, NV = not verified in reviewed directories. "Src" = model range sources; TWG/AP sources are the franchise evidence.

---
## Passenger & light-commercial (45 labels, 462 entries)

### Audi (12)
TWG: Audi Bellbowrie | AP: Orange Audi
A1[0001], A3[0002], A5[0003], A6[0004], e-tron GT[0005], Q2[0006], Q3[0007], Q4 e-tron[0008], Q5[0009], Q6 e-tron[0010], Q7[0011], Q8[0012]
Src S012 | TWG S017 | AP S013

### BMW (38 listed; see statuses)
TWG: Albury BMW / Hobart BMW | AP: Coastline BMW
Range: 1 Series[0013], 2 Series Coupe[0014], 2 Series Gran Coupe[0015], 3 Series Sedan[0016], 3 Series Touring[0017], 4 Series Convertible[0018], 4 Series Coupe[0019], 5 Series Sedan[0020], 7 Series[0021], i4[0024], i7[0026], iX[0027], iX1[0028], iX2[0029], iX3[0030], M2[0032], M3 Sedan[0033], M3 Touring[0034], M4 Convertible[0035], M4 Coupe[0036], M5 Sedan[0037], M5 Touring[0038], X1[0039], X2[0040], X3[0041], X5[0044], X5 M[0045], X6[0046], X6 M[0047], X7[0048], XM[0049]
A: i3 Sedan[0023], iX5[0031]
L: X4[0042], X4 M[0043], Z4[0050]
C: 8 Series[0022], i5[0025]
Src S019, S020 | TWG S068 | AP S014

### BYD (16)
TWG: NV | AP: Rockhampton BYD / Bathurst BYD / Dubbo BYD / Orange BYD
Note: explicitly requested by Greg in addition to the two groups.
Range: ATTO 1[0051], ATTO 2[0052], ATTO 2 DM-i[0053], ATTO 3 EVO[0055], DOLPHIN[0056], M9 Premium[0058], SEAL[0059], SEAL 6[0060], SEAL 6 Touring[0061], SEALION 5[0062], SEALION 6[0063], SEALION 7[0064], SEALION 8[0065], SHARK 6[0066]
A: M9 Dynamic[0057] | L: ATTO 3[0054]
Src S001, S002 | AP S014

### Chery (11)
TWG: Bellbowrie Chery | AP: Chery Noosa | Alias: Cherry (misspelling)
Range: C5[0067], C5 Hybrid[0068], E5[0069], Tiggo 4[0071], Tiggo 4 Hybrid[0072], Tiggo 7[0073], Tiggo 7 Super Hybrid[0074], Tiggo 8 Pro Max[0075], Tiggo 8 Super Hybrid[0076], Tiggo 9 Super Hybrid[0077]
A: Stockman[0070]
Src S003 | TWG S017 | AP S014

### Chevrolet (GMSV) (3)
TWG: NV | AP: Cricks Highway GMSV | Alias: GMSV; Chevrolet
Note: GMSV is the dealer channel; Chevrolet is the marque.
Corvette[0078], Silverado 1500[0079], Silverado 2500 HD[0080]
Src S035 | AP S014

### Deepal (3)
TWG: NV | AP: Cricks Highway Deepal / Deepal Maroochydore
E07[0081], S05[0082], S07[0083]
Src S024 | AP S014

### Fiat Professional (2)
TWG: NV | AP: Sunshine Coast Fiat Professional | Alias: Fiat vans
Ducato[0084], Scudo[0085]
Note: commercial-vehicle franchise only. Do not infer Fiat passenger or Abarth rights.
Src S026 | AP S014

### Ford (12)
TWG: Blacklocks Ford | AP: Dubbo Ford / Bayford Ford
E-Transit Custom[0086], Everest[0087], F-150[0088], Mustang[0089], Mustang Mach-E[0090], Ranger[0091], Ranger Hybrid[0092], Ranger Raptor[0093], Ranger Super Duty[0094], Tourneo[0095], Transit Custom[0096], Transit Van[0097]
Src S027, S028 | TWG S018 | AP S013

### Foton (2)
TWG: NV | AP: Sunshine Coast Foton / Cricks Highway Foton | Alias: Foton LCV
Tunland V7[0098], Tunland V9[0099]
Note: light-commercial only; specialist truck distribution checked separately.
Src S029 | AP S014

### GAC (4)
TWG: Bellbowrie GAC | AP: GAC Preston
AION UT[0100], AION V[0101], EMZOOM[0102], M8[0103]
Src S032 | TWG S017 | AP S016

### Geely (3)
TWG: Bellbowrie Geely | AP: Geely Ferntree Gully / Geely Lilydale
EX2[0104], EX5[0105], Starray EM-i[0106]
Src S033, S034 | TWG S017 | AP S016

### GMC (GMSV) (1)
TWG: NV | AP: Cricks Highway GMSV | Alias: GMC; GMSV
Yukon[0107]
Note: a GMSV franchise does not prove all GMC models are available; confirm model-specific authorisation.
Src S035 | AP S014

### GWM (12)
TWG: Bellbowrie GWM | AP: Blackburn GWM / Cricks Highway GWM | Alias: Great Wall; Haval; Tank; Ora
Range: Cannon[0108], Cannon Alpha[0109], Haval H6[0112], Haval H6GT[0113], Haval H7[0114], Haval Jolion[0115], Ora 5[0116], Tank 300[0117], Tank 500[0118]
A: Cannon Alpha 3.0L Diesel[0110], Cannon PHEV[0111], Tank 500 3.0L Diesel[0119]
Note: Haval, Tank, Ora are model lines under GWM, not separate franchises.
Src S036 | TWG S017 | AP S016

### Honda (7)
TWG: Reef City Honda | AP: Caloundra City Honda / DC Motors Honda
Accord[0120], Civic[0121], Civic Type R[0122], CR-V[0123], HR-V[0124], Prelude[0125], ZR-V[0126]
Src S039 | TWG S064 | AP S014

### Hyundai (28)
TWG: Brighton Hyundai | AP: Ferntree Gully Hyundai / DC Motors Hyundai
Range: ELEXIO[0127], i20 N[0128], i30 N[0129], i30 Sedan[0130], i30 Sedan Hybrid[0131], i30 Sedan N[0132], i30 Sedan N Line[0133], INSTER[0134], IONIQ 5[0135], IONIQ 5 N[0136], IONIQ 6 N[0137], IONIQ 9[0138], KONA[0139], KONA Electric[0140], KONA Hybrid[0141], MIGHTY Electric[0142], PALISADE Hybrid[0143], SANTA FE[0145], SANTA FE Hybrid[0146], SONATA N Line[0147], STARIA[0148], STARIA Load[0149], STARIA Load Hybrid[0150], STARIA Lounge[0151], TUCSON[0152], TUCSON Hybrid[0153], VENUE[0154]
A: PALISADE XRT PRO[0144]
Src S040 | TWG S021 | AP S016

### Isuzu UTE (2)
TWG: Blacklocks Isuzu UTE | AP: Keystar Isuzu UTE | Alias: Isuzu D-MAX; MU-X
D-MAX[0155], MU-X[0156]
Note: distinct from Isuzu Trucks.
Src S042 | TWG S018 | AP S014

### JAC (3)
TWG: Blacklocks JAC | AP: Sunshine Coast JAC / Keystar JAC
Hunter[0157], T9 Cab Chassis[0158], T9 Ute[0159]
Src S009 | TWG S018 | AP S014

### Jaecoo (7)
TWG: Omoda Jaecoo Albury / Ferntree Gully | AP: Omoda Jaecoo Maroochydore
Range: J5 EV[0160], J5 Petrol[0161], J7[0163], J7 SHS-P[0164], J8[0165], J8 SHS-P[0166]
A: J5 SHS-H[0162]
Src S059 | TWG S068 | AP S014

### Jaguar (6)
TWG: Trinity Jaguar | AP: NV
All L: E-PACE[0167], F-PACE[0168], F-TYPE[0169], I-PACE[0170], XE[0171], XF[0172]
Note: confirm new-order availability during brand transition.
Src S044 | TWG S070

### Jeep (4)
TWG: Northern Jeep | AP: Keystar Jeep Redcliffe
Range: Gladiator[0174], Wrangler[0176] | L: Avenger[0173] | C: Grand Cherokee[0175]
Src S045 | TWG S058 | AP S014

### KGM (6)
TWG: Blacklocks SsangYong | AP: Cricks SsangYong Sunshine Coast | Alias: SsangYong
Actyon[0177], Musso[0178], Musso EV[0179], Rexton[0180], Torres[0181], Torres EVX[0182]
Note: some listings keep SsangYong name; preserve SsangYong identity for used vehicles.
Src S010 | TWG S018 | AP S014

### Kia (17 listed)
TWG: Northern Kia / Mornington Kia | AP: Cricks Noosa Kia / Ferntree Gully Kia
Range: Carnival[0183], EV3[0184], EV4[0185], EV5[0186], EV6[0187], EV9[0188], K4[0189], Picanto[0190], Seltos[0192], Sorento[0193], Sorento Hybrid[0194], Sportage[0195], Sportage Hybrid[0196], Stonic[0197], Tasman[0198], Tasman Cab Chassis[0199]
C: PV5[0191]
Src S049 | TWG S058 | AP S014

### Land Rover (13)
TWG: Bellbowrie Land Rover | AP: NV | Alias: Range Rover; Defender; Discovery
Range: Defender 110[0200], Defender 130[0201], Defender 90[0202], Defender OCTA[0204], Discovery[0205], Range Rover[0207], Range Rover Evoque[0209], Range Rover Sport[0211], Range Rover Velar[0212]
A: Range Rover Electric[0208], Range Rover GT[0210]
C: Defender Hard Top[0203], Discovery Sport[0206]
Src S046, S047, S063 | TWG S017

### LDV (13)
TWG: NV | AP: Rockhampton LDV / Bathurst LDV
D90[0213], Deliver 7[0214], Deliver 9 Bus[0215], Deliver 9 Cab Chassis[0216], Deliver 9 Campervan[0217], Deliver 9 Motorhome[0218], Deliver 9 Van[0219], eDeliver 5[0220], eDeliver 7[0221], eDeliver 9[0222], G10+[0223], T60 MAX[0224], Terron 9[0225]
Src S048 | AP S014

### Leapmotor (7)
TWG: Northern Leapmotor | AP: NV | Alias: Leepmotor (misspelling)
Range: B05[0227], B10[0228], B10 Hybrid EV[0229], C10[0230], C10 Hybrid EV / REEV[0232]
A: B03X[0226], C10 AWD Sports+[0231]
Src S023 | TWG S058

### Lepas (1)
TWG: Lepas Cairns / Ferntree Gully Lepas | AP: NV
A: L6 EV[0233]. Note: national launch/order status must be checked separately.
Src S025 | TWG S068

### Mazda (13)
TWG: Burnie Mazda / Hobart Mazda | AP: Caloundra Mazda / Rockhampton Mazda
BT-50[0234], CX-3[0235], CX-30[0236], CX-5[0237], CX-60[0238], CX-6e[0239], CX-70[0240], CX-80[0241], CX-90[0242], Mazda2[0243], Mazda3[0244], Mazda6e[0245], MX-5[0246]
Src S050 | TWG S068 | AP S014

### Mercedes-Benz (41 listed)
TWG: Mercedes-Benz Cairns / West Orange Mercedes-Benz | AP: DC Motors Mercedes-Benz | Alias: Mercedes; AMG; Maybach
Range: A-Class Hatchback[0247], C-Class Sedan[0249], CLA[0250], CLA Electric[0251], CLE Cabriolet[0252], CLE Coupe[0253], E-Class Sedan[0254], EQA[0255], EQB[0256], eSprinter Panel Van[0258], eVito Panel Van[0259], eVito Tourer[0260], G-Class[0261], G-Class Electric[0262], GLA[0263], GLB[0265], GLC[0267], GLC Coupe[0268], GLC Electric[0269], Mercedes-AMG GT Coupe[0274], Mercedes-Maybach S-Class[0276], Mercedes-Maybach SL[0277], SL Roadster[0279], Sprinter Cab Chassis[0280], Sprinter Dual Cab Chassis[0281], Sprinter Panel Van[0282], V-Class[0283], Vito Crew Cab[0284], Vito Panel Van[0285], Vito Tourer[0286]
A: C-Class Electric[0248], EQS[0257], GLA Electric[0264], GLB Electric[0266], GLE[0270], GLE Coupe[0271], GLS[0272], Mercedes-AMG GT 4-Door Electric[0273], Mercedes-Maybach GLS[0275], S-Class[0278], VLE[0287]
Note: cars and vans need the right dealership channel; trucks listed separately.
Src S052, S053 | TWG S068 | AP S014

### MG (14)
TWG: Northern MG / Hobart MG | AP: Rockhampton MG
Cyberster[0288], HS[0289], IM5[0290], IM6[0291], MG3[0292], MG4 EV[0293], MG4 EV Urban[0294], MG5[0295], MG7[0296], MGS5 EV[0297], MGS6 EV[0298], MGU9[0299], QS[0300], ZS[0301]
Src S011 | TWG S058 | AP S014

### MINI (7)
TWG: Hobart MINI Garage | AP: Coastline MINI Garage
Aceman[0302], Cooper 3-Door[0303], Cooper 5-Door[0304], Cooper Convertible[0305], Cooper Electric[0306], Countryman[0307], Countryman Electric[0308]
Src S054 | TWG S068 | AP S014

### Mitsubishi (9)
TWG: Albion Park Mitsubishi | AP: Caloundra City Mitsubishi / Cricks Mitsubishi
Range: ASX[0309], Eclipse Cross Plug-in Hybrid EV[0310], Outlander[0311], Outlander Plug-in Hybrid EV[0312], Pajero Sport[0314], Triton[0315], Triton Cab Chassis[0316], Triton Raider[0317]
A: Pajero (all-new)[0313]
Src S055, S056, S060 | TWG S068 | AP S014

### Nissan (6)
TWG: Bellbowrie Nissan | AP: Cricks Nambour Nissan / Blackburn Nissan
ARIYA[0318], Navara[0319], Patrol[0320], QASHQAI[0321], X-TRAIL[0322], Z[0323]
Src S057 | TWG S017 | AP S014

### Omoda (1)
TWG: Omoda Jaecoo Albury / Ferntree Gully | AP: Omoda Jaecoo Maroochydore
9 SHS-P[0324]. Note: older Omoda 5 / E5 sold under Chery are not a separate Omoda franchise record.
Src S059 | TWG S068 | AP S014

### Peugeot (10)
TWG: NV | AP: Gateway Peugeot
2008 Hybrid[0325], 3008 Hybrid[0326], 308 Hybrid[0327], 408 Hybrid[0328], 5008 Hybrid[0329], Boxer[0330], E-Expert[0331], E-Partner[0332], Expert[0333], Partner[0334]
Src S061 | AP S013

### Porsche (7)
TWG: Porsche Centre Hobart | AP: NV
Range: 911[0336], Cayenne[0337], Cayenne Electric[0338], Macan Electric[0339], Panamera[0340], Taycan[0341] | L: 718[0335]
Src S004-S008 | TWG S068

### RAM (6)
TWG: Northern RAM / Blacklocks RAM | AP: Caloundra City RAM / Cricks Nambour RAM | Alias: RAM Trucks
Range: 1500 HEMI V8[0342], 1500 Hurricane[0343], 2500[0345], 3500[0346]
A: 1500 Rumble Bee[0344], SRT TRX[0347]
Src S062 | TWG S058 | AP S014

### Renault (12)
TWG: NV | AP: Cricks Highway Renault
Range: Arkana Hybrid[0348], Duster[0349], Kangoo[0350], Kangoo E-Tech[0351], Koleos[0352], Master Van[0353], Master Van E-Tech[0354], Megane E-Tech[0355], Scenic E-Tech[0357], Symbioz[0358], Trafic[0359]
A: Renault 5 Turbo 3E[0356]
Src S065 | AP S014

### Subaru (9)
TWG: Trinity Subaru / Reef City Subaru | AP: Cricks Subaru / Keystar Subaru
Range: BRZ[0360], Crosstrek[0361], Forester[0362], Impreza[0363], Outback[0364], Solterra[0365], Trailseeker[0366], WRX[0368]
A: Uncharted[0367]
Src S022 | TWG S070 | AP S014

### Suzuki (8)
TWG: Bellbowrie Suzuki / Blacklocks Suzuki | AP: Caloundra City Suzuki
e VITARA[0369], Fronx Hybrid[0370], Ignis[0371], Jimny[0372], S-CROSS[0373], Swift Hybrid[0374], Swift Sport[0375], Vitara Hybrid[0376]
Src S067 | TWG S017 | AP S014

### Toyota (32)
TWG: Illawarra Toyota / Launceston Toyota / Orange Toyota | AP: NV
Range: bZ4X[0379], bZ4X Touring[0380], C-HR[0381], Camry[0382], Coaster[0383], Corolla Cross[0384], Corolla Hatch[0385], Corolla Sedan[0386], GR Corolla[0389], GR Yaris[0391], GR86[0392], HiAce[0394], HiLux[0395], Kluger[0397], LandCruiser 300[0399], LandCruiser 70[0400], LandCruiser Prado[0401], RAV4[0403], Tundra[0406], Yaris[0407], Yaris Cross[0408]
L: 86[0377], Aurion[0378], FJ Cruiser[0387], Fortuner[0388], GR Supra[0390], Granvia[0393], HiLux GR Sport[0396], LandCruiser 200[0398], Prius[0402], Rukus[0404], Tarago[0405]
Src S069 | TWG S068

### Volkswagen (28)
TWG: Ferntree Gully Volkswagen / Orange Volkswagen | AP: Cricks Volkswagen / Bayford Volkswagen | Alias: VW; VW Commercial Vehicles
Range: Amarok[0409], Caddy[0411], Caddy California[0412], Caddy Cargo[0413], Crafter Cab Chassis[0414], Crafter Kampervan[0415], Crafter Van[0416], Golf[0417], Golf GTI[0418], Golf R[0419], ID. Buzz[0420], ID. Buzz Cargo[0421], ID.4[0422], ID.5[0423], Multivan[0424], Polo[0425], Polo GTI[0426], T-Cross[0427], T-Roc[0428], T-Roc R[0429], Tayron[0430], Tayron eHybrid[0431], Tiguan[0432], Tiguan eHybrid[0433], Touareg[0434], Touareg R[0435], Transporter[0436]
A: Amarok W600 Walkinshaw[0410]
Note: commercial vs passenger allocation varies by dealer.
Src S071 | TWG S068 | AP S014

### Volvo (8)
TWG: Volvo Cars Hobart | AP: Volvo Cars Springwood | Alias: Volvo Cars
Range: ES90[0437], EX30[0438], EX40[0439], EX90[0441], XC40[0442], XC60[0443], XC90[0444] | C: EX60[0440]
Note: Volvo Cars only; no Volvo Trucks franchise inferred.
Src S072 | TWG S068 | AP S014

### XPeng (3)
TWG: XPENG Brighton / Bellbowrie XPENG | AP: XPENG Sunshine Coast / Springwood
Range: G6[0445] | A: G9[0446], X9[0447]
Src S075 | TWG S017 | AP S014

### Zeekr (3)
TWG: NV | AP: Zeekr Sunshine Coast / Zeekr Cars Springwood | Alias: Zeeka (misspelling)
009[0448], 7X[0449], X[0450]
Src S074 | AP S014

### Škoda (12)
TWG: Bellbowrie Škoda | AP: Cricks Škoda Sunshine Coast | Alias: Skoda
Elroq[0451], Enyaq[0452], Enyaq Coupe[0453], Fabia[0454], Kamiq[0455], Karoq[0456], Kodiaq[0457], Octavia[0458], Octavia Wagon[0459], Scala[0460], Superb[0461], Superb Wagon[0462]
Src S066 | TWG S017 | AP S014

---
## Legacy / service (not a current range)

### Holden (12, all L)
TWG: Wilson Holden service / Brighton Holden service | AP: Bathurst Holden / Gateway Holden (service/legacy listings only)
Acadia[0476], Astra Hatch[0477], Astra Sedan[0478], Astra Sportswagon[0479], Colorado[0480], Commodore Liftback[0481], Commodore Tourer[0482], Commodore Wagon[0483], Equinox[0484], Spark[0485], Trailblazer[0486], Trax[0487]
Note: retired new-car marque; do not advertise new factory orders. Selected names only, not a full history.
Src S038 | TWG S068 | AP S013

---
## Trucks & bus series (6 labels, 33 entries)
Keep separate from passenger recommendations; confirm specialist dealership channel.

- **Freightliner (2)**: TWG NV | AP: Daimler Trucks Sunshine Coast. Cascadia 116[0463], Cascadia 126[0464]. Src S030 | AP S015
- **Fuso (6)**: TWG NV | AP: Daimler Trucks Sunshine Coast. Built Ready[0465], Canter[0466], eCanter[0467], Fighter[0468], Rosa[0469], Shogun[0470]. Src S031 | AP S015
- **Hino (5)**: TWG: West Orange Motors Hino | AP NV. 300 Series[0471], 300 Series Hybrid Electric[0472], 500 Series[0473], 700 Series[0474], Built to Go[0475]. Src S037 | TWG S073
- **Isuzu Trucks (5)**: TWG: Blacklocks Truck Centre | AP NV. F Series[0488], FX Series[0489], FY Series[0490], N Series[0491], Ready-to-Work[0492]. Not Isuzu UTE. Src S041 | TWG S018
- **IVECO (7)**: TWG: Blacklocks Truck Centre | AP NV. ACCO[0493], Daily Cab Chassis[0494], Daily Motorhome[0495], Daily Van[0496], Eurocargo[0497], S-Way[0498], T-Way[0499]. Src S043 | TWG S018
- **Mercedes-Benz Trucks (8, all C)**: TWG NV | AP: Daimler Trucks Sunshine Coast. Actros[0500], Actros ProCabin[0501], Arocs[0502], Atego[0503], eActros[0504], Econic[0505], eEconic[0506], Unimog[0507]. Src S051 | AP S015

---
## Motorcycle & powersports (directory only; no model records)
Not part of the 507 vehicle entries. Confirm any specialist referral before offering it.
- TWG: Blacklocks Motorcycles (src S018) for: Aprilia, Honda Motorcycles, Moto Guzzi, Piaggio, Polaris, Ural, Vespa. AP: NV for all of these.
- BMW Motorrad: TWG Blacklocks Motorcycles (S018) | AP Coastline BMW Motorcycles (S014).

---
## Totals
507 model/range entries (462 passenger/LCV + 33 truck/bus + 12 Holden), 60 network brand labels, 75 sources.

## Source register (all reviewed 2 Oct 2026; shows range or relationship evidence, not live inventory)
Model range: S001-S002 bydautomotive.com.au | S003 cherymotor.com.au | S004-S008 dealer.porsche.com | S009 elnjac.com.au | S010 kgm.com.au | S011 mgmotor.com.au | S012 audi.com.au | S019-S020 bmw.com.au | S022 crickssubaru.com.au | S023 csleapmotor.com.au | S024 deepal.com.au | S025 ferntreegullyautomotive.com.au | S026 fiat.com.au | S027-S028 ford.com.au | S029 fotonaustralia.com.au | S030 freightliner.com.au | S031 fuso.com.au | S032 gacgroup.com | S033 geelyessendon.com.au | S034 geelyliverpool.com.au | S035 gmspecialtyvehicles.com (Chevrolet and GMC GMSV) | S036 gwmanz.com | S037 hino.com.au | S038 holden.com.au | S039 honda.com.au | S040 hyundai.com | S041 isuzu.com.au (Trucks) | S042 isuzuute.com.au | S043 iveco.com | S044 jaguar.com | S045 jeep.com.au | S046-S047 landrover.com.au | S048 ldvautomotive.com.au | S049 lilydalekia.com.au | S050 mazda.com.au | S051 mercedes-benz-trucks.com | S052-S053 mercedes-benz.com.au | S054 mini.com.au | S055 mitsubishi-motors.com.au | S056 mitsubishi-motors.com | S057 nissan.com.au | S059 omodajaecoo.com.au (Jaecoo and Omoda) | S060 pacificmitsubishi.com.au | S061 peugeot.com.au | S062 ramtrucks.com.au | S063 rangerover.com | S065 renault.com.au | S066 skoda.com.au | S067 suzuki.com.au | S069 toyota.com.au | S071 volkswagen.com.au | S072 volvocars.com | S074 zeekrlife.com | S075 xpeng.com.au

Tony White Group franchise evidence: S017 bellbowriemotors.com.au | S018 blacklocks.com.au | S021 brightonauto.com.au | S058 northernmotorgroup.com.au | S064 reefcitymotors.com.au | S068 tonywhitegroup.au | S070 trinityauto.com.au | S073 westorangemotors.com.au

Autopact franchise evidence (all autopact.com.au): S013, S014, S015 (trucks), S016`;

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge-base helper functions
// ─────────────────────────────────────────────────────────────────────────────

async function buildKnowledgeBaseBlock() {
  const entries = await KnowledgeEntry.find({}, "label text").lean();
  if (!entries.length) return null;
  return entries
    .map((e) => `### ${e.label}\n\n${e.text}`)
    .join("\n\n---\n\n");
}

async function kbTotalChars() {
  const result = await KnowledgeEntry.aggregate([
    { $group: { _id: null, total: { $sum: "$charCount" } } },
  ]);
  return result[0]?.total ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory session store
// ─────────────────────────────────────────────────────────────────────────────

const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  let pruned = 0;
  for (const [id, session] of sessions.entries()) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
      sessions.delete(id);
      pruned++;
    }
  }
  if (pruned > 0)
    console.log(`[Sessions] Pruned ${pruned} expired sessions. Active: ${sessions.size}`);
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt  ★ UPDATED
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Buy My Next Car AI Concierge — a vehicle buying consultant for Buy My Next Car (Australia). You are not a general-purpose assistant; you represent Buy My Next Car in every reply and never break that role.

## Key Message
Our promise is: **"Instant conversation. Human-verified answers."** Chatting right now is instant — but any concrete number (a price, a repayment figure, a trade-in value, a finance outcome, stock availability) is always confirmed by a real person before it is final. Be upfront about this when it matters — it builds trust.

---

## Identity Rules (strict)
- NEVER say "As an AI", "As a language model", or similar. You are the Buy My Next Car Concierge.
- NEVER say "I can't", "I'm unable to", "I don't have the ability to". Speak in terms of what Buy My Next Car or "our team" / "our specialists" will do.
  - "I can't check that" → "We'll check that for you."
  - "I'm unable to give a valuation" → "One of our specialists will review that and get back to you with an estimate."
  - "I can't analyse images" → "Thanks — one of our specialists will review it."
- Never send a customer to an external site or third party. Never say "check RedBook", "speak to your bank", "contact the dealer/manufacturer". Instead say "We can help with that", "We'll organise that for you", "Let's work through it together."

---

## Company & Contact Details
**${COMPANY.tradingAs}** is operated by **${COMPANY.legalName}** (ABN ${COMPANY.abn} · ACN ${COMPANY.acn}), a ${COMPANY.companyType.toLowerCase()} registered with the ${COMPANY.regulator}, with its registered office in ${COMPANY.registeredOfficeLocality}.

- Phone: **${COMPANY.phone}**
- Email: **${COMPANY.email}**
- Website governed by laws of **Victoria, Australia**

If a customer asks for ABN, ACN, legal name, phone or email, give these exact details. For anything beyond entity identity — credit licence numbers, the Privacy Policy, Terms, Credit Guide, or the complaints process — say a specialist will provide that; do not invent numbers or links.

---

## Personality & Response Pacing
- Warm, confident, professional — like an experienced Australian car buying consultant, not a search engine.
- Australian English ("ute" not "pickup truck", "petrol" not "gas", "kilometres" not "miles", "rego" not "license plate").
- Pacing & Length:
  - For quick acknowledgements or initial greetings: Keep it short (1–3 sentences).
  - When presenting vehicle options or comparisons: Provide a structured, high-value **Shortlist (2 to 3 specific Australian models)** with real-world specs and a clear side-by-side comparison. Never give lazy 1-line generic suggestions or stall with repeated questions!
- Ask at most ONE, maximum TWO questions per message. Never bundle a long laundry list of questions.
- Always acknowledge and lock in what the customer just stated before moving forward.
- Consultative, not reactive: every reply should move the customer closer to finding the ideal vehicle, comparing real models, and letting our team source competitive dealer pricing. (Do not introduce finance unless the customer explicitly asks).

---

## MARKET LOCK — Australia Only (critical, non-negotiable)
This service exclusively supports the **Australian** new and used vehicle market.
- NEVER mention overseas model names, US-only trims, or unavailable powertrains.
- All pricing is in AUD (driveaway or RRP before on-roads).
- All efficiency is in L/100km and electric range is in km (tested under ADR 81/02 or WLTP test cycles).

### Common Overseas Hallucinations (DO NOT MENTION IN AUSTRALIA):
-  **Toyota RAV4 Prime (PHEV)**: DO NOT MENTION. It is NOT sold in Australia! Toyota Australia only sells the series-parallel RAV4 Hybrid (GX, GXL, XSE, Cruiser, Edge).
-  **Ford Escape / Escape PHEV**: DO NOT MENTION. Discontinued in Australia (Ford exited this segment in Australia).
-  **Hyundai Tucson PHEV / Santa Fe PHEV**: DO NOT MENTION. In Australia, Tucson and Santa Fe are sold as regular hybrids (HEV), petrol, or diesel, NOT plug-in hybrids.
-  **Kia Sportage PHEV**: DO NOT MENTION. In Australia, Sportage is petrol, diesel, or regular hybrid (HEV).
-  **Subaru Crosstrek / Forester PHEV**: DO NOT MENTION. In Australia, Subaru only sells mild hybrid (e-Boxer), no plug-in hybrid.
-  **Honda CR-V PHEV**: DO NOT MENTION. In Australia, CR-V is turbo petrol or e:HEV regular hybrid.
-  **US Trims (LE, XLE, SE, Limited, Platinum, Lariat)**: In Australia, trim names are GX, GXL, Cruiser, GT-Line, Aspire, Exceed, Dynamic, Premium, SR, SR5, Wildtrak, etc.

### Australian Plug-in Hybrid (PHEV) Benchmark (True Australian Market Models):
**INDICATIVE REFERENCE ONLY** — the prices, ranges and trims below are general guidance, NOT live pricing or live stock. Always present prices as indicative ("~") and say our specialists confirm current driveaway pricing and availability with the dealer.
If a customer asks for a Plug-in Hybrid (PHEV), ONLY recommend models currently sold in Australia:
1. **BYD Sealion 6** (Dynamic FWD ~$48,990 driveaway | Premium AWD ~$52,990 driveaway)
   - Segment: Mid-size 5-seat SUV
   - Pure EV Range: ~80–90 km (18.3 kWh Blade battery)
   - Highlights: Outstanding tech, ultra-low fuel consumption (approx 1.1–1.4L/100km combined), high-value standard inclusions, nationwide warranty.
2. **Mitsubishi Outlander PHEV** (ES, Aspire, Exceed, Exceed Tourer AWD | ~$57,000–$74,000 driveaway)
   - Segment: Medium/Large SUV (available in both 5-seat and 7-seat options)
   - Pure EV Range: ~84 km (20 kWh battery)
   - Highlights: Twin-motor Super-All Wheel Control (S-AWC), 7-seat versatility on higher trims, 10-year manufacturer warranty, proven Japanese reliability.
3. **Mitsubishi Eclipse Cross PHEV** (ES, Aspire, Exceed AWD | ~$47,000–$55,000 driveaway)
   - Segment: Compact AWD SUV, ~55 km pure EV range.
4. **MG HS Plus EV / HS PHEV** (Excite, Essence | ~$43,000–$48,000 driveaway)
   - Segment: Budget-friendly mid-size SUV, ~63 km EV range.
5. **GWM Haval H6 GT / H6 PHEV** (Ultra | ~$55,000 driveaway | Distinctive coupe-SUV styling, strong power).
6. **Kia Sorento PHEV** (GT-Line AWD | ~$81,000 driveaway | Premium 7-seater large SUV, ~68 km EV range).
7. **Mazda CX-60 PHEV / CX-80 PHEV / CX-90 PHEV** (Evolve, Touring, GT, Azami | ~$72,000–$87,000 | ~76 km EV range, rear-biased luxury platform).
8. **Cupra Formentor VZe / Leon VZe** (~$64,000 driveaway | ~50 km EV range, European performance styling).
9. **Lexus NX 450h+ / RX 450h+** (~$90,000+ | Luxury Japanese PHEV).
10. **BYD Shark 6 PHEV** (~$57,900 RRP / ~$60k driveaway | Dual-cab plug-in hybrid ute, ~100 km EV range, 2.5-tonne towing, 321kW AWD).

### Knowledge Base Precedence & Status Codes (critical)
- If a **Knowledge Base** section is provided, it OVERRIDES the benchmark list above wherever the two differ or the Knowledge Base covers the same brand/model. The benchmark list is only a fallback when the Knowledge Base is silent.
- Never present a benchmark price as confirmed. If the Knowledge Base says it is not a price, stock or spec check, do not quote any price as live.
- When the Knowledge Base tags a model with a status code, follow it:
  - **A** (announced / pre-order): do NOT promise immediate supply; say it is announced or available to pre-order and our team will confirm timing.
  - **L** (legacy / run-out stock): do NOT call it current factory production; say any remaining stock is run-out and our team will check what is available.
  - **C** (confirm order status): say our team will confirm with the local dealer whether it can currently be ordered.
  - No tag: it appears in the reviewed Australian range, but stock, grades and new-order availability are still confirmed by our team.
- "Not verified" (NV) in the Knowledge Base means not covered by our records, NOT unavailable in Australia. Never guess specs or invent prices; say our specialists will confirm.
- Keep brand labels separate as the Knowledge Base does (e.g. Isuzu UTE vs Isuzu Trucks, Mercedes-Benz vs Mercedes-Benz Trucks) and never infer one franchise from another.

---

## BUYER REQUIREMENT MEMORY (STRICT & UNBREAKABLE)
- You must retain and respect all previously stated customer preferences across the entire conversation (e.g., fuel type, seating capacity, budget, body style, new/used, must-have features).
- **CRITICAL FUEL TYPE RULE**:
  - If a customer specifies "plug-in hybrid" (PHEV), EVERY single vehicle you recommend MUST be a genuine plug-in hybrid available in Australia (e.g. BYD Sealion 6, Mitsubishi Outlander PHEV). NEVER suggest a conventional hybrid (like Toyota RAV4 Hybrid, Corolla Cross, or Camry) or petrol car!
  - If they specify "electric" (EV), ONLY suggest pure battery electric vehicles (e.g. Tesla Model Y, BYD Atto 3, MG4).
  - If they specify "7 seats", do not recommend 5-seaters without clear disclosure and 7-seat alternative.
- NEVER drop, ignore, or contradict an established preference later in the conversation.

---

## SHORTLIST & COMPARISON PROTOCOL (NO BROAD REPETITIONS)
When a customer gives you their criteria or asks what to consider:
1. **Never repeat broad, generic suggestions or stall with open-ended questions** when you already have enough information to show real cars.
2. **Present a Curated Shortlist of 2 to 3 Specific Australian Models**:
   - Give the exact Make, Model, and Australian Variant/Badge (e.g., *BYD Sealion 6 Dynamic* or *Mitsubishi Outlander PHEV Aspire*).
   - List key real-world figures: Pure EV battery range (in km), combined fuel economy (L/100km), drive layout (FWD or AWD), and seating.
   - Provide an indicative Australian driveaway price bracket (e.g., ~$48k–$53k driveaway).
   - State the #1 standout reason to choose that vehicle.
3. **Provide a Meaningful Head-to-Head Comparison**:
   - Compare the trade-offs directly in 2–3 sentences:
     *e.g., "If pure electric daily driving range and cutting-edge cabin tech are your top priorities at a sharper price point, the **BYD Sealion 6** is hard to beat. However, if you need the peace of mind of mechanical AWD and the option for 7 seats, the **Mitsubishi Outlander PHEV** is the more versatile family workhorse."*
4. **Focused Next Step**:
   - Ask ONE clear, forward-moving question (e.g., "Between those two, do you lean more towards the tech and value of the Sealion 6, or the AWD versatility of the Outlander? We can check live dealer inventory and pricing on either.").

---

## Sourcing & Availability Enquiries (Strict Sourcing Protocol)
When a customer asks what Australian source you are relying on, or how new vehicle availability is verified:
- **Cite Concrete Manufacturer Sources**: State clearly that specifications, trims, and indicative pricing are referenced directly from official Australian manufacturer releases and importer catalogs (e.g., Mitsubishi Motors Australia for the Outlander PHEV, BYD Automotive Australia for the Sealion 6, MG Motor Australia for the HS PHEV).
- **Explain Live Availability Verification**: Reiterate our core service and promise ("Instant conversation. Human-verified answers"): our vehicle specialists verify live showroom availability, current factory allocations, and driveaway pricing directly with authorized Australian franchised dealers before any deal is locked in.
- **NEVER invent or claim "ADR certified vehicle listings"**: ADR (Australian Design Rules) approval is only a regulatory homologation standard for road compliance; it does NOT prove current new vehicle retail availability or dealer stock. Never cite ADR, ROVER, or RVCS compliance lists as a source for current showroom sales!

---

## Wording You Must Not Use
-  "licensed finance broker" (when referring to Buy My Next Car) →  "our finance specialists" / "our finance team"
-  "pre-approval in seconds" or any promised speed/outcome for finance →  "an indicative assessment"
-  "soft credit check" or any description of the credit check type
-  "5-star ANCAP" or any specific ANCAP/safety rating for a vehicle
-  "100% protected", "guaranteed approval", or any absolute promise
-  "we provide finance", "our lenders", "we approve finance" (Buy My Next Car does NOT provide credit)
-  Any personalised interest rate, repayment figure, or loan amount
-  "best rate", "lowest repayment", "wholesale rate", "guaranteed saving"
-  Do NOT claim that vehicles are "confirmed by the official Australian Design Rules (ADR) certified vehicle listings" or cite ADR/RVCS registers as proof of current showroom stock or new car availability.

---

## How We Get Paid (if asked)
We don't charge the customer. We're paid by the dealer or lender once a vehicle purchase or finance settlement goes through. Chatting, trade valuations, and finance referrals are all free for you.
We may receive a commission or referral benefit if a customer proceeds with finance arranged by our broker partner. This is disclosed before any referral consent is collected.

---

## Your Core Role
1. **Vehicle Consultant** — Understand what the customer needs before recommending anything. Focus on vehicle features, trims, budget, and dealer sourcing.
2. **Finance Referral Concierge (On Request Only)** — Walk customers through a natural, conversational finance referral ONLY when requested (NOT credit assessment — see Finance Referral section below). NEVER pitch finance unprompted.
3. **Trade Valuation Concierge** — Collect details needed for a specialist to prepare an estimated trade value.
4. **Multi-language** — Converse in English, Mandarin (中文), Arabic (العربية), Hindi (हिन्दी), and others as needed.

---

## Collecting Contact Details
- When a customer is interested in receiving deals, dealer offers, valuations, or finance, collect their name and at least one contact method (phone number or email address).
- Once they provide their details:
  - Thank them warmly using their name.
  - If they provided an email, let them know: "I've also sent a summary of our chat and your enquiry details to your email for your records."
  - Reassure them that our specialists are reaching out to dealers across Australia and will be in touch with verified pricing and options shortly.

---

## VEHICLE CONVERSATION — natural, consultative flow
Guide them through: new or used? → vehicle type/brand/model? → intended use (personal, business, fleet)? → budget? → features/lifestyle needs? → location/delivery? → timing?
When key criteria are present, move directly into the Shortlist & Comparison protocol.

---

## FINANCE REFERRAL — Rules (critical, non-negotiable)

**CRITICAL RULE: DO NOT PUSH OR CHASE FINANCE UNLESS REQUESTED**
- Buy My Next Car is first and foremost a car-buying and dealer-sourcing concierge.
- When a customer asks about getting the best deal, finding a car, vehicle pricing, specs, trims, trade-ins, or how Buy My Next Car works, KEEP THE CONVERSATION 100% FOCUSED ON THE CAR AND DEALER SOURCING.
- NEVER proactively bring up finance, never ask if they want finance, and NEVER dump finance commission disclosures or finance partner details unless the customer EXPLICITLY asks about finance, repayments, borrowing, interest rates, or loans.
- Specifically, if asked "how does getting the best deal work?" or "how do you help find deals?": explain how we gather their vehicle preferences, model, options, and budget, and negotiate directly across our nationwide Australian dealer network to source competitive pricing. DO NOT mention finance referrals, do NOT ask if they want a finance partner to contact them, and do NOT attach any disclaimers!

**What Buy My Next Car is:** A finance referrer only. We do NOT provide credit assistance, assess creditworthiness, recommend a particular lender or credit product, or approve finance.

**Our broker partner:** Acquired Financial Services Pty Ltd (Australian Credit Licence **${FINANCE_PARTNER.acl}**), trading as Acquired Finance.
- Phone: ${FINANCE_PARTNER.phone}
- Website: ${FINANCE_PARTNER.website}
- Lender panel: ${FINANCE_PARTNER.lenderPanel} bank and non-bank lenders

### What you MAY say about finance (ONLY when customer asks about finance/repayments)
- "Our broker partner can compare options across a panel of ${FINANCE_PARTNER.lenderPanel}+ bank and non-bank lenders."
- "Their broker will discuss available rates and repayments based on your circumstances."
- "The initial broker conversation does not commit you to take a loan."
- "The broker can explain the pre-approval process and whether a credit enquiry may be required before you proceed."
- "They'll aim to match your circumstances with an appropriate lender and reduce unnecessary applications."
- "Broker channels may include lender offers not advertised directly to the public, subject to availability and your eligibility."

### What you MUST NOT say or do
- Do NOT quote or calculate a personalised interest rate, repayment or loan amount.
- Do NOT say a customer qualifies, is approved, or will be pre-approved.
- Do NOT recommend a particular lender, loan, lease, or credit product.
- Do NOT ask for or assess income, expenses, assets, liabilities, employment, credit history, or bank statements.
- Do NOT say a credit score will definitely be protected or there will be no credit impact.
- Do NOT guarantee any rate, repayment, approval timing, saving, or outcome.
- Do NOT submit an application or present the referral as an application.
- Do NOT collect driver licences, bank statements, payslips, or tax file numbers — tell the customer to provide those directly to the broker.

### Finance referral workflow (ONLY when customer asks about finance/repayments)
1. **Never bring up finance unprompted**: Do NOT mention finance, finance partners, or finance referral disclosures when discussing car deals, models, or pricing, unless the customer specifically asks about finance, repayments, borrowing, or loans.
2. **When customer asks about finance / repayments**:
   - Explain that Buy My Next Car does not provide credit or quote repayment numbers directly.
   - Introduce our partner: "Our broker partner is **Acquired Financial Services Pty Ltd** (ACL ${FINANCE_PARTNER.acl}), trading as Acquired Finance, who compare options from over ${FINANCE_PARTNER.lenderPanel} bank and non-bank lenders to find competitive rates and repayments tailored to your situation."
   - Disclose the referral benefit transparently: "Test Drive Group may receive a commission or referral benefit if you proceed with finance arranged by Acquired Finance."
   - Ask simply: "Would you like me to connect you with an Acquired Finance broker for an obligation-free discussion about repayments and options?"
3. **CRITICAL — STRICTLY NO COPY-PASTE CONSENT / TESTIMONIAL**:
   - NEVER, UNDER ANY CIRCUMSTANCES, ask the customer to copy-and-paste, repeat, confirm, or type out any formal consent declaration, legal statement, disclaimer, or testimonial paragraph.
   - NEVER provide a quote block or text in quotation marks asking them to agree or confirm with that wording.
   - When the customer gives a natural affirmative answer (e.g. "sure", "yes", "sounds good", "please do", "okay", "yeah", "proceed"), or provides their contact details for finance, that natural response IS their full consent.
   - Acknowledge their confirmation warmly and naturally: e.g., "Thanks [Name], I'll pass your enquiry and contact details over to Acquired Finance so their broker can reach out to you with competitive options and repayments."
4. **Reuse Existing Contact Details**:
   - If you already have their name and phone/email from earlier in the chat, REUSE THOSE DETAILS. DO NOT ask for them again!
   - If not yet provided, politely collect their name, phone number (or email), and vehicle of interest. Nothing else.

### Finance complaints routing
- Complaints about the referral process, consent, or privacy → **Test Drive Group Pty Ltd** at ${COMPANY.email} or ${COMPANY.phone}
- Complaints about credit assistance, a finance recommendation, or a finance application → **Acquired Financial Services** on ${FINANCE_PARTNER.phone} (details in their Credit Guide)

---

## TRADE VALUATION
Collect: rego (or make/model/year), odometer, service history, condition, photos (encouraged), name and contact. **Never quote a figure yourself.** Say a specialist will review and provide an estimate.

---

## PHOTO / IMAGE HANDLING
Encourage photos for trade valuations. Confirm receipt warmly; say a specialist will review them. Do not claim to analyse images yourself.

---

## TERMS & CONDITIONS — Key Points (if asked)
- Buy My Next Car is a vehicle concierge, sourcing and referral service operated by Test Drive Group Pty Ltd — NOT the vehicle seller or dealer.
- Vehicle purchase contracts are between the customer and the relevant licensed dealer or seller.
- All prices, trade values, availability statements, and dealer packages are indicative until confirmed in writing by the relevant dealer or provider.
- AI-generated responses are general information only — not a guarantee, valuation, legal advice, financial advice, or credit assistance.
- The service is governed by the laws of Victoria, Australia.
- Full Terms: refer customers to the Buy My Next Car website or contact ${COMPANY.email}.

---

## PRIVACY — Key Points (if asked)
- Personal information is handled in accordance with the Privacy Act 1988 (Cth) and Australian Privacy Principles.
- Information collected is used to respond to enquiries, source vehicles, coordinate referrals, and operate the service.
- Information may be disclosed to dealers, finance brokers, and service providers to fulfil requests.
- Finance referral information (name, phone, brief vehicle/purpose) is only provided to Acquired Financial Services with explicit customer consent.
- Customers may request access, correction, or deletion: contact ${COMPANY.email} or ${COMPANY.phone}.
- Privacy complaints: contact ${COMPANY.email} or ${COMPANY.phone} in the first instance.
- Full Privacy Policy: refer customers to the Buy My Next Car website.

---

## COMPLAINTS
- Complaints about Buy My Next Car: ${COMPANY.email} or ${COMPANY.phone}
- Complaints about a vehicle sale: direct to the dealer or seller
- Complaints about credit assistance or a finance application: direct to Acquired Financial Services on ${FINANCE_PARTNER.phone}

---

## Formatting Guidelines
- Minimal markdown — light **bold** and clean bullet points for vehicle shortlists.
- Never repeat the same disclaimer more than once in a conversation.
- Never refer to yourself as an AI or language model.`;

const HANDOFF_NUDGE = `IMPORTANT — this conversation has now covered a good amount of ground. In your NEXT reply: briefly (1–2 sentences) summarise what you've learned so far, let the customer know a specialist will now take it from here, and invite them to share their name and best phone number or email so the team can reach them. Keep it warm, not abrupt.`;

// ─────────────────────────────────────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes("*")
      ? "*"
      : (origin, cb) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
        else cb(new Error(`Origin ${origin} not allowed`));
      },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use(
  express.static(path.join(__dirname, "public"), {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".js") || filePath.endsWith(".css"))
        res.setHeader("Cache-Control", "public, max-age=300");
    },
  })
);

app.get("/favicon.ico", (_req, res) => res.status(204).end());

// ─────────────────────────────────────────────────────────────────────────────
// Multer — trade-in photo uploads
// ─────────────────────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const sessionId = (req.body && req.body.sessionId) || "unknown-session";
      const safe = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
      const ext = path.extname(file.originalname || "").slice(0, 10);
      cb(null, `${safe}_${Date.now()}_${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
    cb(null, ok.includes(file.mimetype));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Multer — knowledge-base document uploads (PDF / TXT)
// ─────────────────────────────────────────────────────────────────────────────

const kbUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, KB_UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase().slice(0, 10);
      cb(null, `kb_${Date.now()}_${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const okTypes = [
      "application/pdf",
      "text/plain",
      "text/txt",
      "text/csv",
      "application/json",
      "text/markdown",
      "text/x-markdown",
      "application/vnd.ms-excel",
    ];
    const okExts = [".pdf", ".txt", ".csv", ".json", ".md"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (okTypes.includes(file.mimetype) || okExts.includes(ext)) cb(null, true);
    else cb(new Error("Accepted file types for knowledge base: PDF, TXT, CSV, JSON, and MD."));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Text-extraction helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractTextFromTxt(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

async function extractTextFromPdf(filePath) {
  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch {
    throw new Error("pdf-parse is not installed. Run: npm install pdf-parse");
  }
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function validateMessage(msg) {
  if (!msg || typeof msg !== "string") return false;
  const t = msg.trim();
  return t.length >= 1 && t.length <= 5000;
}

function validateLanguage(lang) {
  const allowed = ["English", "Mandarin", "Arabic", "Hindi"];
  return !lang || allowed.includes(lang) ? lang || "English" : "English";
}

function getOrCreateSession(incomingId, language) {
  let sessionId = incomingId;
  let session;
  if (sessionId && sessions.has(sessionId)) {
    session = sessions.get(sessionId);
    session.updatedAt = new Date();
  } else {
    sessionId = incomingId || uuidv4();
    session = {
      messages: [],
      language: validateLanguage(language),
      uploads: [],
      userTurns: 0,
      buyerRequirements: {
        fuelType: null,
        vehicleType: null,
        budget: null,
        seating: null,
        condition: null,
        mustHaves: [],
      },
      handoverRequested: false,
      handoverSubmitted: false,
      leadContact: null,
      leadEmailSent: false,
      customerEmailSent: false,
      financeReferralConsented: false,
      financeEmailSent: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    sessions.set(sessionId, session);
  }
  return { sessionId, session };
}

function recordUserTurn(session) {
  session.userTurns = (session.userTurns || 0) + 1;
}

function updateBuyerRequirements(session, message) {
  if (!session) return;
  if (!session.buyerRequirements) {
    session.buyerRequirements = {
      fuelType: null,
      vehicleType: null,
      budget: null,
      seating: null,
      condition: null,
      mustHaves: [],
    };
  }
  const req = session.buyerRequirements;
  const text = String(message || "");
  const lower = text.toLowerCase();

  // ── Fuel type / Powertrain ───────────────────────────────────────────────
  if (/\b(?:plug-in hybrid|phev|plug in hybrid|plug-in)\b/i.test(lower)) {
    req.fuelType = "Plug-in Hybrid (PHEV)";
  } else if (
    /\b(?:all electric|pure electric|bev|battery electric|full electric)\b/i.test(lower) ||
    (/\bev\b/i.test(lower) && !/\bphev\b/i.test(lower))
  ) {
    req.fuelType = "Electric (EV)";
  } else if (/\bhybrid\b/i.test(lower) && !req.fuelType) {
    req.fuelType = "Hybrid (HEV)";
  } else if (/\bdiesel\b/i.test(lower) && !/\bhybrid\b/i.test(lower)) {
    req.fuelType = "Diesel";
  } else if (/\bpetrol\b/i.test(lower) && !/\bhybrid\b/i.test(lower)) {
    req.fuelType = "Petrol";
  }

  // ── Vehicle type / Body style ─────────────────────────────────────────────
  if (/\b(?:7|seven)[- ]?seat(?:er)?s?\b/i.test(lower)) {
    req.seating = "7 seats";
  } else if (/\b(?:5|five)[- ]?seat(?:er)?s?\b/i.test(lower)) {
    req.seating = "5 seats";
  } else if (/\b(?:8|eight)[- ]?seat(?:er)?s?\b/i.test(lower)) {
    req.seating = "8 seats";
  }

  if (/\b(?:ute|dual[- ]?cab|pickup|cab[- ]?chassis)\b/i.test(lower)) {
    req.vehicleType = "Ute / Dual-Cab";
  } else if (/\bsuv\b/i.test(lower)) {
    if (/\b(?:compact|small)\s+suv\b/i.test(lower)) req.vehicleType = "Small SUV";
    else if (/\b(?:mid[- ]?size|medium)\s+suv\b/i.test(lower)) req.vehicleType = "Medium SUV";
    else if (/\b(?:large|7[- ]?seat)\s+suv\b/i.test(lower)) req.vehicleType = "Large SUV";
    else req.vehicleType = req.vehicleType || "SUV";
  } else if (/\bhatchback|hatch\b/i.test(lower)) {
    req.vehicleType = "Hatchback";
  } else if (/\bsedan\b/i.test(lower)) {
    req.vehicleType = "Sedan";
  } else if (/\bpeople mover|van\b/i.test(lower)) {
    req.vehicleType = "People Mover / Van";
  }

  // ── Budget ───────────────────────────────────────────────────────────────
  const budgetMatch =
    text.match(/\$(?:[0-9]{1,3},?[0-9]{3}|\d+k)\b/i) ||
    text.match(/\b(?:under|budget(?:\s+is|\s+of)?|around|max(?:imum)?|up to)\s*(?:\$)?\s*([0-9]{2,3}(?:,?[0-9]{3})?|\d{2,3}k)\b/i);
  if (budgetMatch) {
    req.budget = budgetMatch[0].trim();
  }

  // ── Condition ────────────────────────────────────────────────────────────
  if (/\b(?:brand new|new car|new vehicle)\b/i.test(lower)) {
    req.condition = "New";
  } else if (/\b(?:used|second[- ]?hand|pre[- ]?owned)\b/i.test(lower)) {
    req.condition = "Used / Pre-owned";
  } else if (/\bdemo|demonstrator\b/i.test(lower)) {
    req.condition = "Demo";
  }

  // ── Features & Must-Haves ────────────────────────────────────────────────
  if (/\bawd|all[- ]?wheel[- ]?drive|4x4|4wd\b/i.test(lower)) {
    if (!req.mustHaves.includes("AWD/4x4")) req.mustHaves.push("AWD/4x4");
  }
  if (/\btow(?:ing)?\b/i.test(lower)) {
    if (!req.mustHaves.includes("Towing capability")) req.mustHaves.push("Towing capability");
  }
  if (/\bleather\b/i.test(lower)) {
    if (!req.mustHaves.includes("Leather interior")) req.mustHaves.push("Leather interior");
  }
  if (/\bsunroof|panoramic\b/i.test(lower)) {
    if (!req.mustHaves.includes("Sunroof")) req.mustHaves.push("Sunroof");
  }
}

function formatBuyerRequirementsBlock(session) {
  if (!session || !session.buyerRequirements) return null;
  const req = session.buyerRequirements;
  const lines = [];

  if (req.fuelType) {
    lines.push(
      `- Powertrain / Fuel Type: **${req.fuelType}** ${req.fuelType.includes("Plug-in")
        ? "(CRITICAL: Customer specifically requested a Plug-in Hybrid. You MUST ONLY recommend genuine Australian Plug-in Hybrid models, e.g. BYD Sealion 6, Mitsubishi Outlander PHEV, Eclipse Cross PHEV, MG HS Plus EV, etc. NEVER suggest regular non-plug-in hybrids or petrol cars!)"
        : ""
      }`
    );
  }
  if (req.vehicleType) lines.push(`- Body Type: **${req.vehicleType}**`);
  if (req.seating) lines.push(`- Seating Capacity: **${req.seating}**`);
  if (req.budget) lines.push(`- Budget: **${req.budget}**`);
  if (req.condition) lines.push(`- Condition: **${req.condition}**`);
  if (req.mustHaves && req.mustHaves.length > 0)
    lines.push(`- Key Requirements: **${req.mustHaves.join(", ")}**`);

  if (lines.length === 0) return null;

  return (
    "## Active Customer Profile & Constraints (MANDATORY REQUIREMENT MEMORY):\n" +
    lines.join("\n") +
    "\n\n**STRICT ENFORCEMENT:** You MUST honor every constraint above in all vehicle recommendations, shortlists, and comparisons. If the customer requested a Plug-in Hybrid, you are strictly forbidden from suggesting standard petrol hybrids (like Toyota RAV4 Hybrid) or non-plug-in vehicles."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contact extraction & referral intent helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeRegExp(string) {
  return String(string || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractEmail(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i);
  return match ? match[0].trim().toLowerCase() : null;
}

function extractPhone(text) {
  if (!text || typeof text !== "string") return null;
  const match =
    text.match(/(?:(?:\+?61\s?(?:4|[2378]))|(?:\b0[23478]))(?:\s?\d){8}\b/) ||
    text.match(/(?:\+?61\s?)?0?4\d{2}[\s.-]?\d{3}[\s.-]?\d{3}\b/) ||
    text.match(/\b04\d{8}\b/);
  return match ? match[0].replace(/[\s.-]/g, "").trim() : null;
}

function extractName(text, email, phone) {
  if (!text || typeof text !== "string") return null;
  let cleaned = text;
  if (email) cleaned = cleaned.replace(new RegExp(escapeRegExp(email), "gi"), " ");
  if (phone) cleaned = cleaned.replace(new RegExp(escapeRegExp(phone), "gi"), " ");
  cleaned = cleaned.replace(
    /\b(?:my name is|i am|i'm|call me|name is|this is|it's|email|phone|mobile|number|at|is|and|or|contact me at|details are|here are my details|mailto)\b/gi,
    " "
  );
  cleaned = cleaned.replace(/[<>()[\]{}|:;,\-_\n\r]/g, " ").replace(/\s+/g, " ").trim();

  // If text contains enquiry verbs or common vehicle words, it is not a pure name
  const nonNameWords = /\b(?:interested|looking|buying|vehicle|car|hybrid|sealion|suv|sedan|ute|budget|dealer|price|quote|finance|repayment|hello|hi|hey|thanks|thank|please|yes|no|help|deal|need)\b/i;
  if (nonNameWords.test(cleaned)) {
    return null;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 3 && cleaned.length >= 2 && cleaned.length <= 40 && /[a-zA-Z]/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

function extractNameFromAssistantReply(assistantText) {
  if (!assistantText || typeof assistantText !== "string") return null;
  const match = assistantText.match(
    /(?:Thanks|Thank you|Hi|Hello|Great to hear from you),?\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)[!.,]/
  );
  return match ? match[1].trim() : null;
}

function extractVehicleInterest(session) {
  if (!session || !session.messages) return "Vehicle Enquiry";

  // Check structured requirements first if captured
  if (session.buyerRequirements) {
    const req = session.buyerRequirements;
    if (req.fuelType && req.vehicleType) {
      return `${req.fuelType} ${req.vehicleType}${req.budget ? ` (${req.budget})` : ""}`;
    }
  }

  for (let i = session.messages.length - 1; i >= 0; i--) {
    const text = session.messages[i].content || "";
    const vMatch =
      text.match(
        /(?:deals on the|looking for in the|interested in the|pricing for the|options for the|quote on the|deals for the|best deal on the)\s+([^?.!\n,]+)/i
      ) ||
      text.match(
        /(?:looking at the|considering the|enquiring about the|interested in)\s+([^?.!\n,]+)/i
      ) ||
      text.match(
        /(?:Sealion\s?[67]|BYD\s?Sealion\s?[67]|BYD\s?Shark(?:\s?6)?|Mitsubishi\s?Outlander(?:\s?PHEV)?|Eclipse\s?Cross(?:\s?PHEV)?|MG\s?HS(?:\s?Plus\s?EV)?|Kia\s?Sorento(?:\s?PHEV)?|Mazda\s?CX-[0-9]+|Toyota\s?[A-Za-z0-9]+|RAV4|Hilux|Corolla|Camry|Ford\s?Ranger|Kia\s?[A-Za-z0-9]+|Hyundai\s?[A-Za-z0-9]+|Tesla\s?Model\s?[3YSE])/i
      );
    if (vMatch) {
      let raw = vMatch[1] ? vMatch[1].trim() : vMatch[0].trim();
      raw = raw.replace(/\s*(?:you're interested in|you are interested in|you're after|you are after|that fits your needs|you want)\s*$/i, "").trim();
      return raw || "Vehicle Enquiry";
    }
  }
  return "Vehicle Enquiry";
}

function detectFinanceReferralConsent(userMsg, lastAssistantMsg) {
  if (!userMsg || !lastAssistantMsg) return false;
  const assistantAskedFinance =
    /(?:finance partner|finance broker|Acquired Finance|Acquired Financial|broker to contact you|arrange for a finance broker|set that up for you|connect you with|arrange that for you|obligation-free|repayments and options|discuss finance options|chat with a broker)/i.test(
      lastAssistantMsg
    );
  if (!assistantAskedFinance) return false;

  const affirmative =
    /^(?:sure|yes|yeah|yep|yup|please|yes please|ok|okay|sounds good|go ahead|proceed|certainly|do that|yes do that|yes refer me|definitely|absolutely)[\s.!,]*$/i.test(
      userMsg.trim()
    ) ||
    /\b(?:yes please|go ahead|sounds good|refer me|connect me|that would be great|set that up|i would like that|let's do that)\b/i.test(userMsg);

  return affirmative;
}

/**
 * Calls OpenAI with the session history.
 * Fetches the current knowledge base from MongoDB and injects it as a
 * system message so the AI answers from stored content first.
 */
async function getAssistantReply(session, language, { nudgeHandoff = false, isSms = false } = {}) {
  const llmMessages = [{ role: "system", content: SYSTEM_PROMPT }];

  // ── Inject active buyer constraints block ───────────────────────────────
  const buyerBlock = formatBuyerRequirementsBlock(session);
  if (buyerBlock) {
    llmMessages.push({ role: "system", content: buyerBlock });
  }

  // ── Inject built-in Network Index (Tony White Group + Autopact + BYD) ───
  if (BUILTIN_NETWORK_INDEX && BUILTIN_NETWORK_INDEX.trim()) {
    llmMessages.push({
      role: "system",
      content:
        "## BMNC Network Index (Tony White Group + Autopact + BYD)\n\n" +
        BUILTIN_NETWORK_INDEX.trim(),
    });
  }

  // ── Inject dynamic knowledge base from MongoDB ──────────────────────────
  const kbBlock = await buildKnowledgeBaseBlock();
  if (kbBlock) {
    llmMessages.push({
      role: "system",
      content:
        "## Knowledge Base\n" +
        "The following information has been provided by the business. " +
        "Use it as your PRIMARY source of truth for product details, policies, pricing, FAQs, " +
        "inventory, and any business-specific information. " +
        "Always prefer these facts over general knowledge.\n\n" +
        kbBlock,
    });
  }

  if (language && language !== "English") {
    llmMessages.push({
      role: "system",
      content: `The user has selected ${language} as their preferred language. Please respond in ${language} from now on.`,
    });
  }

  if (isSms) {
    llmMessages.push({
      role: "system",
      content:
        "## SMS Formatting & Tone Guidelines:\n" +
        "- You are replying via SMS text message to the customer's phone.\n" +
        "- Keep responses concise, direct, and conversational (1 to 3 short sentences max).\n" +
        "- Do NOT use markdown syntax (no markdown headers, no bold asterisks, no bullet lists, no markdown links).\n" +
        "- Keep it natural, warm, and easy to read on a mobile phone screen.",
    });
  }

  if (nudgeHandoff) {
    llmMessages.push({ role: "system", content: HANDOFF_NUDGE });
  }

  const historyLimit = isSms ? -10 : -20;
  for (const msg of session.messages.slice(historyLimit)) {
    llmMessages.push({ role: msg.role, content: msg.content });
  }

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages: llmMessages,
    max_tokens: isSms ? 300 : 900,
    temperature: 0.6,
  });

  return (
    completion.choices?.[0]?.message?.content ||
    "Sorry, that didn't come through properly on our end — could you try sending that again?"
  );
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderTranscriptHtml(messages, isCustomerFacing = false) {
  return messages
    .filter((m) => !(isCustomerFacing && m.role === "system"))
    .map((m) => {
      const who =
        m.role === "assistant"
          ? "Buy My Next Car Concierge"
          : m.role === "system"
            ? "Internal Note"
            : isCustomerFacing
              ? "You"
              : "Customer";
      const bg =
        m.role === "assistant" ? "#F0FDFA" : m.role === "system" ? "#F3F4F6" : "#F8FAFC";
      const border =
        m.role === "assistant" ? "#0F766E" : m.role === "system" ? "#9CA3AF" : "#2563EB";
      return `<div style="margin:0 0 12px;padding:12px 16px;background:${bg};border-left:4px solid ${border};border-radius:6px;">
        <div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${who}</div>
        <div style="font-size:13px;color:#1E293B;white-space:pre-wrap;line-height:1.5;">${escapeHtml(m.content)}</div>
      </div>`;
    })
    .join("");
}

async function notifyLeadByEmail(sessionId, session, contact, isFinanceUpdate = false) {
  if (!LEAD_EMAIL_READY) {
    console.log(`[Handover] Email not configured — lead for session ${sessionId} stored in-memory.`);
    return;
  }

  const isFinance = isFinanceUpdate || !!session.financeReferralConsented;
  const vehicle = extractVehicleInterest(session);
  const title = isFinance ? "★ Finance Referral Consent Received" : "New Chat Lead";
  const subject = isFinance
    ? `★ Finance Referral Consent — Buy My Next Car — ${contact.name}${vehicle !== "Vehicle Enquiry" ? ` (${vehicle})` : ""}`
    : `New lead — Buy My Next Car — ${contact.name}${vehicle !== "Vehicle Enquiry" ? ` (${vehicle})` : ""}`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;color:#2C3338;">
      <h2 style="color:#0F766E;margin-top:0;">${title}</h2>
      <p style="color:#6B7280;font-size:13px;">Session ${escapeHtml(sessionId)} · ${escapeHtml(session.language || "English")}</p>
      ${isFinance ? '<div style="background:#FEF3C7;border-left:4px solid #F59E0B;padding:10px 14px;border-radius:4px;margin:12px 0;font-size:13px;"><strong>Finance Consent:</strong> Customer agreed to be contacted by Acquired Financial Services Pty Ltd (ACL 488607).</div>' : ''}
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <tr><td style="padding:5px 0;font-weight:600;width:120px;color:#64748B;">Name</td><td style="font-weight:600;">${escapeHtml(contact.name)}</td></tr>
        <tr><td style="padding:5px 0;font-weight:600;color:#64748B;">Phone</td><td>${escapeHtml(contact.phone || "—")}</td></tr>
        <tr><td style="padding:5px 0;font-weight:600;color:#64748B;">Email</td><td>${escapeHtml(contact.email || "—")}</td></tr>
        <tr><td style="padding:5px 0;font-weight:600;color:#64748B;">Vehicle</td><td style="font-weight:600;color:#0F766E;">${escapeHtml(vehicle)}</td></tr>
        ${contact.notes ? `<tr><td style="padding:5px 0;font-weight:600;color:#64748B;vertical-align:top;">Notes</td><td>${escapeHtml(contact.notes)}</td></tr>` : ''}
        <tr><td style="padding:5px 0;font-weight:600;color:#64748B;">Photos</td><td>${session.uploads.length} attached</td></tr>
      </table>
      <h3 style="color:#1E293B;margin-top:24px;border-bottom:1px solid #E2E8F0;padding-bottom:6px;">Conversation Transcript</h3>
      ${renderTranscriptHtml(session.messages, false)}
      <p style="color:#9CA3AF;font-size:11px;margin-top:20px;">
        Indicative guidance only — confirm all pricing, availability, trade value and finance figures directly with the customer.
      </p>
    </div>`;

  const attachments = session.uploads
    .filter((u) => fs.existsSync(u.path))
    .map((u, idx) => ({
      filename: u.originalName || `trade-in-photo-${idx + 1}.jpg`,
      path: u.path,
      contentType: u.mimeType,
    }));

  const sender = `"${COMPANY.tradingAs}" <${LEAD_NOTIFY_FROM}>`;
  try {
    await mailTransporter.sendMail({
      from: sender,
      to: LEAD_NOTIFY_EMAIL.join(","),
      subject,
      html,
      attachments,
    });
    console.log(`[Mail] Lead email sent for session ${sessionId} (${isFinanceUpdate ? "finance update" : "initial lead"})`);
  } catch (err) {
    console.error("[Mail] Failed to send lead email:", err?.message || err);
  }
}

async function sendCustomerConfirmationEmail(sessionId, session, contact, isFinanceUpdate = false) {
  if (!mailTransporter || !contact || !contact.email) {
    return false;
  }

  const isFinance = isFinanceUpdate || !!session.financeReferralConsented;
  const customerName = contact.name || "there";
  const vehicle = extractVehicleInterest(session);
  const subject = isFinance
    ? `Your finance enquiry update & chat summary — Buy My Next Car`
    : `Your vehicle enquiry & chat summary — Buy My Next Car`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #2C3338; line-height: 1.6;">
      <div style="background: linear-gradient(135deg, #0f4c5c, #0a313d); padding: 26px 22px; border-radius: 10px 10px 0 0; color: #ffffff; text-align: center;">
        <h1 style="margin: 0 0 6px; font-size: 22px; font-weight: 700; letter-spacing: -0.3px;">Buy My Next Car</h1>
        <p style="margin: 0; font-size: 14px; color: #e0f2f1;">${isFinance ? "Finance Enquiry & Chat Summary" : "Vehicle Enquiry & Chat Summary"}</p>
      </div>

      <div style="border: 1px solid #E5E7EB; border-top: none; border-radius: 0 0 10px 10px; padding: 24px 20px; background: #ffffff;">
        <p style="font-size: 15px; margin-top: 0;">Hi <strong>${escapeHtml(customerName)}</strong>,</p>
        <p style="font-size: 14px;">Thanks for chatting with <strong>Buy My Next Car</strong>! We've received your enquiry details.</p>
        <p style="font-size: 14px;">${isFinance
      ? "We have recorded your interest in finance. Our broker partner, <strong>Acquired Financial Services Pty Ltd</strong> (ACL 488607), will be in touch shortly to discuss competitive rates and repayment options across their panel of 63+ lenders."
      : "Our vehicle specialists are now reaching out to our dealer network across Australia to find you the best competitive pricing and deals."}</p>

        <div style="background: #F8FAFC; border-left: 4px solid #0f4c5c; padding: 14px 16px; border-radius: 6px; margin: 18px 0;">
          <h4 style="margin: 0 0 8px; color: #0f4c5c; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Your Details on File</h4>
          <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
            <tr><td style="padding: 3px 0; color: #64748B; width: 100px;">Name:</td><td style="font-weight: 600;">${escapeHtml(contact.name)}</td></tr>
            ${contact.phone ? `<tr><td style="padding: 3px 0; color: #64748B;">Phone:</td><td style="font-weight: 600;">${escapeHtml(contact.phone)}</td></tr>` : ""}
            <tr><td style="padding: 3px 0; color: #64748B;">Email:</td><td style="font-weight: 600;">${escapeHtml(contact.email)}</td></tr>
            <tr><td style="padding: 3px 0; color: #64748B;">Vehicle:</td><td style="font-weight: 600;">${escapeHtml(vehicle)}</td></tr>
            ${contact.notes ? `<tr><td style="padding: 3px 0; color: #64748B;">Notes:</td><td>${escapeHtml(contact.notes)}</td></tr>` : ""}
          </table>
        </div>

        <h3 style="color: #1E293B; font-size: 15px; margin: 22px 0 10px; border-bottom: 1px solid #E2E8F0; padding-bottom: 6px;">Chat History</h3>
        ${renderTranscriptHtml(session.messages, true)}

        <div style="margin-top: 24px; padding-top: 18px; border-top: 1px solid #E2E8F0; font-size: 13px; color: #64748B;">
          <p style="margin: 0 0 6px;"><strong>What happens next?</strong></p>
          <p style="margin: 0 0 14px;">A specialist will review your request and reach out directly with verified information. You don't need to do anything further.</p>
          <p style="margin: 0;">Have questions? Reach us at <a href="mailto:${COMPANY.email}" style="color: #0f4c5c; text-decoration: none;">${COMPANY.email}</a> or phone <strong>${COMPANY.phone}</strong>.</p>
        </div>
      </div>

      <div style="text-align: center; font-size: 11px; color: #94A3B8; padding: 14px 0;">
        ${COMPANY.legalName} trading as ${COMPANY.tradingAs} · ABN ${COMPANY.abn}<br>
        Instant conversation. Human-verified answers.
      </div>
    </div>`;

  const sender = `"${COMPANY.tradingAs}" <${LEAD_NOTIFY_FROM}>`;
  try {
    await mailTransporter.sendMail({
      from: sender,
      to: contact.email,
      subject,
      html,
    });
    console.log(`[Mail] Customer confirmation email sent to ${contact.email} for session ${sessionId} (${isFinanceUpdate ? "finance update" : "initial summary"})`);
    return true;
  } catch (err) {
    console.error("[Mail] Failed to send customer confirmation email:", err?.message || err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS Integration (MobileMessage API)
// ─────────────────────────────────────────────────────────────────────────────

async function sendSms(to, messageText, senderNumber) {
  if (!SMS_CONFIGURED) {
    console.warn("[SMS] MobileMessage not configured — cannot send SMS.");
    return false;
  }

  const credentials = Buffer.from(`${MOBILEMESSAGE_USERNAME}:${MOBILEMESSAGE_PASSWORD}`).toString("base64");
  const url = "https://api.mobilemessage.com.au/v1/messages";
  const from = senderNumber || MOBILEMESSAGE_FROM;

  const payload = {
    messages: [
      {
        to: to,
        message: messageText,
        ...(from ? { sender: from } : {}),
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[SMS] MobileMessage API error:", res.status, data);
      return false;
    }

    console.log(`[SMS] Reply sent from "${from || "Default"}" to ${to}: "${messageText.slice(0, 50)}..."`);
    return true;
  } catch (err) {
    console.error("[SMS] Exception calling MobileMessage API:", err?.message || err);
    return false;
  }
}

async function handleInboundSms(req, res) {
  try {
    const body = req.body || {};
    const query = req.query || {};

    let rawItems = [];

    if (Array.isArray(body)) {
      rawItems = body;
    } else if (Array.isArray(body.messages)) {
      rawItems = body.messages;
    } else if (Array.isArray(body.data)) {
      rawItems = body.data;
    } else if (Array.isArray(body.events)) {
      rawItems = body.events;
    } else {
      rawItems = [body];
    }

    const items = [];
    for (const item of rawItems) {
      const from =
        item.from || item.sender || item.msisdn || item.mobile || item.phone || item.source || item.originator ||
        query.from || query.sender || query.msisdn || query.mobile || query.phone || query.source || query.originator;

      const to =
        item.to || item.destination || item.recipient || item.dest || item.dest_msisdn || item.message_from ||
        query.to || query.destination || query.recipient || query.dest || query.dest_msisdn || query.message_from ||
        MOBILEMESSAGE_FROM;

      const message =
        item.message || item.text || item.content || item.body || item.msg ||
        query.message || query.text || query.content || query.body || query.msg;

      if (from && message) {
        items.push({
          from: String(from).trim(),
          to: String(to || MOBILEMESSAGE_FROM || "").trim(),
          message: String(message).trim(),
        });
      }
    }

    if (items.length === 0) {
      console.warn("[SMS Webhook] Received webhook without recognized SMS fields:", { body, query });
      return res.status(400).json({
        error: "Missing 'from'/'sender' or 'message'/'text' field.",
      });
    }

    for (const item of items) {
      // Ignore delivery receipts, outbound logs, or status callbacks
      if (item.type === "outbound" || item.type === "dlr" || item.status || item.event === "delivery_receipt") {
        console.log(`[SMS Webhook] Ignored status report / delivery event:`, item.status || item.type || item.event);
        continue;
      }

      const fromNum = item.from;
      const toNum = item.to || MOBILEMESSAGE_FROM;
      const userText = item.message;

      if (!fromNum || !userText) continue;

      const cleanFromDigits = fromNum.replace(/[^0-9]/g, "");
      const cleanToDigits = toNum.replace(/[^0-9]/g, "");
      const cleanBotDigits = (MOBILEMESSAGE_FROM || "").replace(/[^0-9]/g, "");

      // ── CRITICAL: Prevent Infinite Loop ──────────────────────────────────
      // If the message is from the bot's own number or sent to itself, ignore.
      if (cleanBotDigits && cleanFromDigits === cleanBotDigits) {
        console.warn(`[SMS Webhook] Loop prevented: Ignored message from bot's own number (${fromNum}).`);
        continue;
      }
      if (cleanFromDigits && cleanFromDigits === cleanToDigits) {
        console.warn(`[SMS Webhook] Loop prevented: Ignored message where sender equals recipient (${fromNum}).`);
        continue;
      }

      console.log(`[SMS Webhook] Inbound message from ${fromNum} to ${toNum}: "${userText}"`);

      const cleanPhone = fromNum.replace(/[^0-9+]/g, "");
      const smsSessionId = `sms_${cleanPhone}`;

      const { session } = getOrCreateSession(smsSessionId, "English");

      if (!session.leadContact) {
        session.leadContact = {
          name: `SMS Customer (${cleanPhone})`,
          phone: cleanPhone,
          email: "",
          notes: `Conversation via MobileMessage SMS to ${toNum || MOBILEMESSAGE_FROM}`,
          submittedAt: new Date(),
        };
      }

      session.messages.push({ role: "user", content: userText });
      recordUserTurn(session);
      updateBuyerRequirements(session, userText);

      const shouldNudgeHandoff =
        !session.handoverRequested && session.userTurns >= MAX_USER_TURNS_BEFORE_HANDOFF;

      let assistantContent;
      try {
        assistantContent = await getAssistantReply(session, "English", {
          nudgeHandoff: shouldNudgeHandoff,
          isSms: true,
        });
      } catch (err) {
        console.error("[SMS OpenAI Error]", err?.message || err);
        assistantContent =
          "Thanks for reaching out to Buy My Next Car! One of our team members will get back to you shortly.";
      }

      if (shouldNudgeHandoff) {
        session.handoverRequested = true;
        if (!session.handoverSubmitted && LEAD_EMAIL_READY) {
          session.handoverSubmitted = true;
          notifyLeadByEmail(smsSessionId, session, session.leadContact).catch((e) =>
            console.error("[SMS Lead Email Error]", e?.message || e)
          );
        }
      }

      session.messages.push({ role: "assistant", content: assistantContent });
      session.updatedAt = new Date();

      // Reply back to user from the number the message was sent to
      await sendSms(fromNum, assistantContent, toNum || MOBILEMESSAGE_FROM);
    }

    return res.json({ success: true, processed: items.length });
  } catch (err) {
    console.error("[SMS Webhook Error]", err?.message || err);
    return res.status(500).json({ error: "Internal server error." });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE ROUTES  (/api/knowledge)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/knowledge
 *
 * Add a knowledge-base entry. Three accepted formats:
 *
 * 1. PDF upload  (multipart/form-data, field "document", .pdf file)
 * 2. TXT upload  (multipart/form-data, field "document", .txt file)
 * 3. Free text   (application/json, body: { "text": "...", "label": "..." })
 *
 * Optional field in all modes: "label" — human-readable name for the entry.
 *
 * Returns 201:
 *   { id, label, source, charCount, totalEntries, totalChars, addedAt }
 *
 * ── curl examples ──────────────────────────────────────────────────────────
 *
 *  PDF:
 *    curl -X POST http://localhost:4099/api/knowledge \
 *      -F "document=@./pricing.pdf" -F "label=Pricing Guide"
 *
 *  TXT:
 *    curl -X POST http://localhost:4099/api/knowledge \
 *      -F "document=@./faq.txt" -F "label=FAQ"
 *
 *  Free text:
 *    curl -X POST http://localhost:4099/api/knowledge \
 *      -H "Content-Type: application/json" \
 *      -d '{ "text": "Toyota Camry 2024 from AUD 38,990.", "label": "Pricing" }'
 */
app.post(
  "/api/knowledge",
  (req, res, next) => {
    const ct = req.headers["content-type"] || "";
    if (ct.includes("multipart/form-data")) kbUpload.single("document")(req, res, next);
    else next();
  },
  async (req, res) => {
    try {
      let text = "";
      let source = "free-text";
      let label = "";

      // ── File upload ──────────────────────────────────────────────────────
      if (req.file) {
        const filePath = req.file.path;
        const ext = path.extname(req.file.originalname || "").toLowerCase();
        label =
          req.body?.label?.trim().slice(0, 200) ||
          req.file.originalname ||
          "Uploaded document";

        try {
          if (ext === ".pdf" || req.file.mimetype === "application/pdf") {
            text = await extractTextFromPdf(filePath);
            source = "pdf";
          } else {
            text = extractTextFromTxt(filePath);
            source = ext ? ext.replace(".", "") : "txt";
          }
        } finally {
          fs.unlink(filePath, () => { });
        }

        if (!text?.trim()) {
          return res.status(422).json({
            error:
              "Could not extract any text from the uploaded file. " +
              "Make sure the PDF is not scanned/image-only and is not password-protected.",
          });
        }
      }

      // ── Free text (JSON) ─────────────────────────────────────────────────
      else if (req.body && typeof req.body.text === "string") {
        text = req.body.text;
        label =
          typeof req.body.label === "string"
            ? req.body.label.trim().slice(0, 200)
            : "Free text entry";
        source = "free-text";
      } else {
        return res.status(400).json({
          error:
            "Provide either a file upload (PDF or TXT) via multipart/form-data with field name 'document', " +
            "or a JSON body with a 'text' field.",
        });
      }

      // ── Validate ─────────────────────────────────────────────────────────
      text = text.trim();
      if (!text) return res.status(400).json({ error: "The provided text is empty." });

      if (text.length > KB_MAX_CHARS_PER_ENTRY) {
        text = text.slice(0, KB_MAX_CHARS_PER_ENTRY);
        console.warn(`[KB] Entry truncated to ${KB_MAX_CHARS_PER_ENTRY} chars.`);
      }

      const currentTotal = await kbTotalChars();
      if (currentTotal + text.length > KB_MAX_TOTAL_CHARS) {
        return res.status(413).json({
          error:
            `Knowledge base is full (${KB_MAX_TOTAL_CHARS.toLocaleString()} char limit). ` +
            "Delete existing entries first via DELETE /api/knowledge/:id or DELETE /api/knowledge.",
          currentTotalChars: currentTotal,
          limitChars: KB_MAX_TOTAL_CHARS,
        });
      }

      if (!label) label = `Entry ${Date.now()}`;

      // ── Persist to MongoDB ────────────────────────────────────────────────
      const id = uuidv4();
      const entry = await KnowledgeEntry.create({
        id,
        label,
        text,
        source,
        charCount: text.length,
      });

      const totalEntries = await KnowledgeEntry.countDocuments();
      const totalChars = await kbTotalChars();

      console.log(
        `[KB] Added id=${id} label="${label}" source=${source} chars=${text.length} totalEntries=${totalEntries}`
      );

      return res.status(201).json({
        id: entry.id,
        label: entry.label,
        source: entry.source,
        charCount: entry.charCount,
        totalEntries,
        totalChars,
        addedAt: entry.addedAt,
      });
    } catch (err) {
      console.error("[KB] Error adding entry:", err?.message || err);
      return res.status(500).json({ error: err?.message || "Failed to process the knowledge base entry." });
    }
  }
);

/**
 * GET /api/knowledge
 * List all entries (metadata only — text excluded for performance).
 */
app.get("/api/knowledge", async (_req, res) => {
  try {
    const entries = await KnowledgeEntry.find({}, "-text -_id -__v").lean();
    const totalChars = await kbTotalChars();

    return res.json({
      totalEntries: entries.length,
      totalChars,
      limitChars: KB_MAX_TOTAL_CHARS,
      entries: entries.map((e) => ({
        id: e.id,
        label: e.label,
        source: e.source,
        charCount: e.charCount,
        addedAt: e.addedAt,
      })),
    });
  } catch (err) {
    console.error("[KB] List error:", err?.message || err);
    return res.status(500).json({ error: "Failed to list knowledge base entries." });
  }
});

/**
 * GET /api/knowledge/:id
 * Retrieve a single entry including its full text.
 */
app.get("/api/knowledge/:id", async (req, res) => {
  try {
    const entry = await KnowledgeEntry.findOne({ id: req.params.id }, "-_id -__v").lean();
    if (!entry) return res.status(404).json({ error: "Knowledge base entry not found." });
    return res.json(entry);
  } catch (err) {
    console.error("[KB] Get error:", err?.message || err);
    return res.status(500).json({ error: "Failed to retrieve knowledge base entry." });
  }
});

/**
 * DELETE /api/knowledge/:id
 * Delete a single entry by its UUID.
 */
app.delete("/api/knowledge/:id", async (req, res) => {
  try {
    const result = await KnowledgeEntry.deleteOne({ id: req.params.id });
    if (result.deletedCount === 0)
      return res.status(404).json({ error: "Knowledge base entry not found." });

    const totalEntries = await KnowledgeEntry.countDocuments();
    const totalChars = await kbTotalChars();
    console.log(`[KB] Deleted id=${req.params.id}. Remaining: ${totalEntries}`);
    return res.json({ success: true, totalEntries, totalChars });
  } catch (err) {
    console.error("[KB] Delete error:", err?.message || err);
    return res.status(500).json({ error: "Failed to delete knowledge base entry." });
  }
});

/**
 * DELETE /api/knowledge
 * Wipe the entire knowledge base.
 */
app.delete("/api/knowledge", async (_req, res) => {
  try {
    const result = await KnowledgeEntry.deleteMany({});
    console.log(`[KB] Cleared entire knowledge base (${result.deletedCount} entries removed).`);
    return res.json({ success: true, deletedEntries: result.deletedCount });
  } catch (err) {
    console.error("[KB] Clear error:", err?.message || err);
    return res.status(500).json({ error: "Failed to clear knowledge base." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Chat Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /health
 */
app.get("/health", async (_req, res) => {
  const kbEntries = await KnowledgeEntry.countDocuments().catch(() => -1);
  const kbChars = await kbTotalChars().catch(() => -1);
  res.json({
    ok: true,
    activeSessions: sessions.size,
    knowledgeBaseEntries: kbEntries,
    knowledgeBaseChars: kbChars,
    mongoState: mongoose.connection.readyState, // 1 = connected
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/chat/message
 * Body: { sessionId?: string, message: string, language?: string }
 * Returns: { sessionId, message, conversationLength, handoffRequired, handoffSubmitted }
 */
app.post("/api/chat/message", async (req, res) => {
  const { sessionId: incomingSessionId, message, language: rawLanguage } = req.body;

  if (!validateMessage(message)) {
    return res.status(400).json({
      error: "Invalid message. Must be a non-empty string up to 5000 characters.",
    });
  }

  const language = validateLanguage(rawLanguage);
  const { sessionId, session } = getOrCreateSession(incomingSessionId, language);

  session.messages.push({ role: "user", content: message });
  recordUserTurn(session);
  updateBuyerRequirements(session, message);

  // ── Extract contact information if user provided details in this turn ──────
  const msgEmail = extractEmail(message);
  const msgPhone = extractPhone(message);
  let msgName = extractName(message, msgEmail, msgPhone);

  if (msgEmail || msgPhone || msgName) {
    if (!session.leadContact) {
      session.leadContact = {
        name: msgName || "Customer",
        phone: msgPhone || "",
        email: msgEmail || "",
        notes: extractVehicleInterest(session),
        submittedAt: new Date(),
      };
    } else {
      if (msgEmail && !session.leadContact.email) session.leadContact.email = msgEmail;
      if (msgPhone && !session.leadContact.phone) session.leadContact.phone = msgPhone;
      if (msgName && (!session.leadContact.name || session.leadContact.name === "Customer")) {
        session.leadContact.name = msgName;
      }
    }
  }

  const shouldNudgeHandoff =
    !session.handoverRequested && session.userTurns >= MAX_USER_TURNS_BEFORE_HANDOFF;

  let assistantContent;
  try {
    assistantContent = await getAssistantReply(session, language, {
      nudgeHandoff: shouldNudgeHandoff,
    });
  } catch (err) {
    console.error("[OpenAI] API error:", err?.message || err);
    const status = err?.status;
    if (status === 429)
      return res.status(429).json({
        error: "Our system's a little busy right now — please try again in a moment.",
      });
    if (status === 401)
      return res.status(500).json({
        error: "We're having a technical issue on our end. Please try again shortly.",
      });
    return res.status(500).json({
      error: "We're having trouble connecting right now. Please try again in a moment.",
    });
  }

  if (shouldNudgeHandoff) {
    session.handoverRequested = true;
    console.log(
      `[Handoff] sessionId=${sessionId} reached ${session.userTurns} turns — nudged toward handover.`
    );
  }

  // If name was not found in user text, check if assistant identified the name
  if (session.leadContact && (session.leadContact.name === "Customer" || !session.leadContact.name)) {
    const nameFromReply = extractNameFromAssistantReply(assistantContent);
    if (nameFromReply) session.leadContact.name = nameFromReply;
  }

  session.messages.push({ role: "assistant", content: assistantContent });
  session.updatedAt = new Date();

  // ── Dispatch emails when contact details are captured ──────────────────────
  // Trigger after assistant response is added so the full conversation transcript is sent
  if (session.leadContact && (session.leadContact.email || session.leadContact.phone)) {
    session.handoverSubmitted = true;
    const isFinance = !!session.financeReferralConsented;

    // 1. Notify team / admin via email
    if (!session.leadEmailSent) {
      session.leadEmailSent = true;
      if (isFinance) session.financeEmailSent = true;
      notifyLeadByEmail(sessionId, session, session.leadContact, isFinance).catch((e) =>
        console.error("[Mail Lead Error]", e?.message || e)
      );
    }

    // 2. Send customer confirmation email with full chat history
    if (session.leadContact.email && !session.customerEmailSent) {
      session.customerEmailSent = true;
      sendCustomerConfirmationEmail(sessionId, session, session.leadContact, isFinance).catch((e) =>
        console.error("[Mail Customer Error]", e?.message || e)
      );
    }
  }

  // ── Detect if customer gave finance referral consent in this turn ──────────
  // Find the last assistant message before the current assistant reply
  let previousAssistantMsg = "";
  for (let i = session.messages.length - 2; i >= 0; i--) {
    if (session.messages[i].role === "assistant") {
      previousAssistantMsg = session.messages[i].content;
      break;
    }
  }

  if (detectFinanceReferralConsent(message, previousAssistantMsg)) {
    session.financeReferralConsented = true;
    if (session.leadContact && !session.financeEmailSent) {
      session.financeEmailSent = true;
      notifyLeadByEmail(sessionId, session, session.leadContact, true).catch((e) =>
        console.error("[Mail Finance Lead Error]", e?.message || e)
      );
      if (session.leadContact.email) {
        sendCustomerConfirmationEmail(sessionId, session, session.leadContact, true).catch((e) =>
          console.error("[Mail Finance Customer Error]", e?.message || e)
        );
      }
    }
  }

  console.log(`[Chat] sessionId=${sessionId} lang=${language} msgCount=${session.messages.length}`);

  return res.json({
    sessionId,
    message: assistantContent,
    conversationLength: session.messages.length,
    handoffRequired: session.handoverRequested,
    handoffSubmitted: session.handoverSubmitted,
  });
});

/**
 * POST /api/chat/upload
 * multipart/form-data: sessionId (text field), photos (one or more image files)
 */
app.post("/api/chat/upload", upload.array("photos", 6), (req, res) => {
  const incomingSessionId = req.body && req.body.sessionId;
  const language = validateLanguage(req.body && req.body.language);

  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: "No photos were received." });

  const { sessionId, session } = getOrCreateSession(incomingSessionId, language);

  const uploadRecords = req.files.map((f) => ({
    filename: f.filename,
    originalName: f.originalname,
    mimeType: f.mimetype,
    path: f.path,
    uploadedAt: new Date(),
  }));
  session.uploads.push(...uploadRecords);
  session.updatedAt = new Date();

  session.messages.push({
    role: "system",
    content:
      `[System note: the customer just uploaded ${req.files.length} photo(s) for their trade valuation/assessment. ` +
      `Total photos so far: ${session.uploads.length}. Acknowledge receipt warmly and let them know a Buy My Next Car ` +
      `specialist will review the photos. Do not claim to have analysed the images yourself.]`,
  });

  console.log(`[Upload] sessionId=${sessionId} files=${uploadRecords.length} totalUploads=${session.uploads.length}`);
  return res.json({ sessionId, uploaded: req.files.length, message: "Photos received." });
});

/**
 * POST /api/chat/handover
 * Body: { sessionId, name, phone?, email?, notes? }
 */
app.post("/api/chat/handover", async (req, res) => {
  const { sessionId, name, phone, email, notes } = req.body;

  if (!sessionId || typeof sessionId !== "string" || !sessions.has(sessionId))
    return res.status(400).json({
      error: "We couldn't find that conversation — please send a message in the chat first.",
    });
  if (!name || typeof name !== "string" || !name.trim())
    return res.status(400).json({ error: "Please include your name." });

  const hasPhone = typeof phone === "string" && phone.trim().length > 0;
  const hasEmail = typeof email === "string" && email.trim().length > 0;
  if (!hasPhone && !hasEmail)
    return res.status(400).json({
      error: "Please include a phone number or email so our team can reach you.",
    });

  const session = sessions.get(sessionId);
  const contact = {
    name: name.trim().slice(0, 200),
    phone: hasPhone ? phone.trim().slice(0, 50) : "",
    email: hasEmail ? email.trim().slice(0, 200) : "",
    notes: typeof notes === "string" ? notes.trim().slice(0, 1000) : "",
    submittedAt: new Date(),
  };

  session.leadContact = contact;
  session.handoverSubmitted = true;
  session.handoverRequested = true;
  session.updatedAt = new Date();

  session.messages.push({
    role: "user",
    content:
      `[Customer submitted their details for specialist follow-up — name: ${contact.name}, ` +
      `phone: ${contact.phone || "—"}, email: ${contact.email || "—"}` +
      (contact.notes ? `, notes: "${contact.notes}"` : "") + `]`,
  });

  await notifyLeadByEmail(sessionId, session, contact);
  session.leadEmailSent = true;

  if (contact.email) {
    await sendCustomerConfirmationEmail(sessionId, session, contact);
    session.customerEmailSent = true;
  }

  console.log(
    `[Handover] sessionId=${sessionId} name=${contact.name} photos=${session.uploads.length} email=${LEAD_EMAIL_READY ? "sent" : "not configured"
    }`
  );

  return res.json({
    success: true,
    message:
      "Thanks — that's with our team now. A specialist will be in touch with verified pricing, availability or finance details shortly.",
  });
});

/**
 * POST /api/chat/reset
 * Body: { sessionId }
 */
app.post("/api/chat/reset", (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== "string")
    return res.status(400).json({ error: "sessionId is required." });

  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    for (const u of session.uploads)
      fs.unlink(u.path, (err) => {
        if (err) console.warn(`[Reset] Could not remove upload ${u.path}:`, err.message);
      });
    session.messages = [];
    session.uploads = [];
    session.userTurns = 0;
    session.handoverRequested = false;
    session.handoverSubmitted = false;
    session.leadContact = null;
    session.leadEmailSent = false;
    session.customerEmailSent = false;
    session.financeReferralConsented = false;
    session.financeEmailSent = false;
    session.updatedAt = new Date();
    console.log(`[Chat] Session reset: ${sessionId}`);
  }

  return res.json({ success: true });
});

/**
 * GET /api/chat/session/:sessionId
 */
app.get("/api/chat/session/:sessionId", (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found." });

  return res.json({
    sessionId: req.params.sessionId,
    messages: session.messages,
    language: session.language,
    uploads: session.uploads.map(({ filename, originalName, mimeType, uploadedAt }) => ({
      filename,
      originalName,
      mimeType,
      uploadedAt,
    })),
    handoffRequired: session.handoverRequested,
    handoffSubmitted: session.handoverSubmitted,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
});

// ── MobileMessage SMS Webhook Routes ─────────────────────────────────────────
app.post("/api/sms/webhook", handleInboundSms);
app.get("/api/sms/webhook", handleInboundSms);
app.post("/api/mobilemessage/webhook", handleInboundSms);
app.get("/api/mobilemessage/webhook", handleInboundSms);
app.post("/api/sms/inbound", handleInboundSms);
app.get("/api/sms/inbound", handleInboundSms);

app.post("/api/sms/send-test", async (req, res) => {
  const { to, message, sender } = req.body || {};
  if (!to || !message) {
    return res.status(400).json({ error: "'to' and 'message' fields are required." });
  }
  const senderNumber = sender || MOBILEMESSAGE_FROM;
  const success = await sendSms(to, message, senderNumber);
  if (success) {
    return res.json({ success: true, message: `SMS sent to ${to} from ${senderNumber || "Default"}` });
  } else {
    return res.status(500).json({ error: "Failed to send SMS." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error("[Server Error]", err);
  if (err?.message?.includes("not allowed"))
    return res.status(403).json({ error: "Origin not allowed." });
  if (err?.message?.includes("Only PDF"))
    return res.status(415).json({ error: err.message });
  res.status(500).json({ error: "Internal server error." });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot — connect to MongoDB first, then start HTTP server
// ─────────────────────────────────────────────────────────────────────────────

async function start() {
  console.log("\n🔌 Connecting to MongoDB…");
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
  });

  app.listen(PORT, () => {
    console.log(`\n🚗 Buy My Next Car — Chatbot Backend`);
    console.log(`   Local:  http://localhost:${PORT}`);
    console.log(`   Public: https://buycarbot.omnisuiteai.com`);
    console.log(`   Model: gpt-4`);
    console.log(`   Uploads dir (private): ${UPLOAD_DIR}`);
    console.log(`   Market: Australia only`);
    console.log(`   Entity: ${COMPANY.legalName} — ABN ${COMPANY.abn} / ACN ${COMPANY.acn}`);
    console.log(`   Finance partner: ${FINANCE_PARTNER.legalName} (ACL ${FINANCE_PARTNER.acl})`);
    console.log(`   Handoff threshold: ${MAX_USER_TURNS_BEFORE_HANDOFF} customer turns`);
    console.log(
      `   Lead emails: ${LEAD_EMAIL_READY ? `${LEAD_NOTIFY_FROM} → ${LEAD_NOTIFY_EMAIL.join(", ")}` : "not configured"
      }`
    );
    console.log(`   Sessions: in-memory`);
    console.log(`   SMS Integration: MobileMessage (${SMS_CONFIGURED ? "Ready (" + (MOBILEMESSAGE_FROM || "Default") + ")" : "Not configured"})`);
    console.log(`     Webhook URL: https://buycarbot.omnisuiteai.com/api/sms/webhook`);
    console.log(`   Knowledge Base: MongoDB (collection: knowledgeentries)`);
    console.log(`\n   ★ Knowledge Base API:`);
    console.log(`     POST   /api/knowledge        — add entry (PDF, TXT, or free text)`);
    console.log(`     GET    /api/knowledge        — list all entries`);
    console.log(`     GET    /api/knowledge/:id    — get single entry (with full text)`);
    console.log(`     DELETE /api/knowledge/:id    — delete single entry`);
    console.log(`     DELETE /api/knowledge        — wipe entire KB\n`);
  });
}

start().catch((err) => {
  console.error("[FATAL] Failed to start:", err?.message || err);
  process.exit(1);
});