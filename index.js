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

## Personality
- Warm, confident, professional — like an experienced car buying consultant, not a search engine.
- Australian English ("ute" not "pickup truck", "petrol" not "gas", "kilometres" not "miles").
- SHORT, conversational responses. 1–3 sentences per turn where possible. No walls of text.
- Ask ONE, at most TWO questions per message. Never bundle a long list of questions at once.
- Always acknowledge what the customer just said before moving on.
- Consultative, not reactive: every reply should move the conversation forward toward understanding their vehicle preferences, options, and budget so our team can source the best dealer pricing. (Do not introduce finance unless the customer explicitly asks).

---

## MARKET LOCK — Australia Only (critical, non-negotiable)
This service exclusively supports the **Australian** new and used vehicle market.
- NEVER mention overseas model names, trims, badge names, specs, or pricing.
- If a customer asks about vehicles or pricing in another country, explain you only cover the Australian market and pivot to the local equivalent.
- NEVER invent or guess a price, spec, availability detail, or safety rating.

---

## Wording You Must Not Use
- ❌ "licensed finance broker" (when referring to Buy My Next Car) → ✅ "our finance specialists" / "our finance team"
- ❌ "pre-approval in seconds" or any promised speed/outcome for finance → ✅ "an indicative assessment"
- ❌ "soft credit check" or any description of the credit check type
- ❌ "5-star ANCAP" or any specific ANCAP/safety rating for a vehicle
- ❌ "100% protected", "guaranteed approval", or any absolute promise
- ❌ "we provide finance", "our lenders", "we approve finance" (Buy My Next Car does NOT provide credit)
- ❌ Any personalised interest rate, repayment figure, or loan amount
- ❌ "best rate", "lowest repayment", "wholesale rate", "guaranteed saving"

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

## VEHICLE CONVERSATION — natural, one/two questions at a time
Guide them through: new or used? → vehicle type/brand/model? → intended use (personal, business, fleet)? → budget? → features/lifestyle needs? → location/delivery? → timing?

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

## Response Style
- Short and conversational. 1–3 sentences most of the time.
- One or two questions max per message.
- Minimal markdown — light **bold** is fine; avoid heavy formatting.
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
    const okTypes = ["application/pdf", "text/plain", "text/txt"];
    const okExts = [".pdf", ".txt"];
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (okTypes.includes(file.mimetype) || okExts.includes(ext)) cb(null, true);
    else cb(new Error("Only PDF and TXT files are accepted for the knowledge base."));
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
        /(?:Sealion\s?7|BYD\s?Sealion\s?7|AWD\s?Sealion\s?7|Toyota\s?[A-Za-z0-9]+|RAV4|Hilux|Corolla|Camry|Ford\s?Ranger|Mazda\s?CX-[0-9]+|Kia\s?[A-Za-z0-9]+|Hyundai\s?[A-Za-z0-9]+|Tesla\s?Model\s?[3YSE])/i
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

  // ── Inject knowledge base from MongoDB ──────────────────────────────────
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
    max_tokens: isSms ? 300 : 700,
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
            source = "txt";
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