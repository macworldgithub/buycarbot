// // require("dotenv").config();

// // const path = require("path");
// // const fs = require("fs");
// // const express = require("express");
// // const cors = require("cors");
// // const { v4: uuidv4 } = require("uuid");
// // const OpenAI = require("openai");
// // const multer = require("multer");
// // const nodemailer = require("nodemailer");

// // // ─────────────────────────────────────────────────────────────────────────────
// // // Configuration
// // // ─────────────────────────────────────────────────────────────────────────────

// // const PORT = process.env.PORT || 4099;
// // const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// // // Deployed at https://buycarbot.omnisuiteai.com — this is both the widget's
// // // asset host (iife.js / iife.css) and the chat API host, so same-origin
// // // requests from the widget work everywhere by default. Add any additional
// // // sites that will EMBED the widget (i.e. the merchant sites placing the
// // // <script> tag) to ALLOWED_ORIGINS so their pages can call this API.
// // const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
// //   ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
// //   : ["*"];

// // // Where uploaded trade-valuation photos are stored. NOT served publicly —
// // // they're only ever read back off disk to attach to the lead email below.
// // // Nothing in this file exposes them over HTTP.
// // const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads-private");
// // if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// // // How many customer messages the AI will handle before it proactively
// // // wraps up and pushes the conversation toward human handover. Answers
// // // "where does the lead go once it hits a limit on the number of questions
// // // it can answer" — after this many turns, the AI nudges the customer to
// // // leave their details, a CTA appears in the widget, and once submitted the
// // // lead (contact + transcript + any uploaded photos) is emailed to the team.
// // const MAX_USER_TURNS_BEFORE_HANDOFF = parseInt(
// //   process.env.MAX_USER_TURNS_BEFORE_HANDOFF || "14",
// //   10
// // );

// // // ── Legal entity / compliance details ───────────────────────────────────────
// // // Single source of truth for the operating entity — interpolated into the
// // // system prompt below (so the AI states these exact figures if asked and
// // // never guesses/invents them) and mirrored in the widget footer
// // // (iife.js — keep COMPANY in sync there if any of this changes).
// // //
// // // NOTE: this covers entity identity only. Finance credit-licence / credit
// // // representative numbers, Privacy Policy / Terms / Credit Guide links, and
// // // the complaints process are NOT included here because they weren't
// // // supplied — add them to COMPANY and to the matching system-prompt section
// // // once you have them, rather than leaving the AI to guess.
// // const COMPANY = {
// //   legalName: "Test Drive Group Pty Ltd",
// //   tradingAs: "Buy My Next Car",
// //   abn: "51 679 064 343",
// //   acn: "679 064 343",
// //   companyType: "Australian Proprietary Company, Limited By Shares",
// //   registrationDate: "12/07/2024",
// //   status: "Registered",
// //   registeredOfficeLocality: "Rowville VIC 3178",
// //   regulator: "Australian Securities & Investments Commission (ASIC)",
// // };

// // if (!OPENAI_API_KEY) {
// //   console.error("[FATAL] OPENAI_API_KEY is not set. Please set it in .env or environment.");
// //   process.exit(1);
// // }

// // const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// // // ── Lead notification email (SMTP) ──────────────────────────────────────────
// // // When a customer submits their details via /api/chat/handover, the full
// // // lead (contact details, conversation transcript, and any uploaded trade-in
// // // photos as attachments) is emailed via this SMTP account to LEAD_NOTIFY_EMAIL.
// // // Set all of these in .env before go-live so leads actually reach the team:
// // //
// // //   SMTP_HOST=smtp.hostinger.com
// // //   SMTP_PORT=465
// // //   SMTP_SECURE=true
// // //   SMTP_USER=you@yourdomain.com
// // //   SMTP_PASS=your-mailbox-password
// // //   LEAD_NOTIFY_EMAIL=leads@yourdomain.com      (where leads land — can be a comma-separated list)
// // //   LEAD_NOTIFY_FROM=you@yourdomain.com          (optional, defaults to SMTP_USER)
// // const SMTP_HOST = process.env.SMTP_HOST || "";
// // const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
// // const SMTP_SECURE = String(process.env.SMTP_SECURE).toLowerCase() === "true";
// // const SMTP_USER = process.env.SMTP_USER || "";
// // const SMTP_PASS = process.env.SMTP_PASS || "";
// // const LEAD_NOTIFY_FROM = process.env.LEAD_NOTIFY_FROM || SMTP_USER;
// // const LEAD_NOTIFY_EMAIL = (process.env.LEAD_NOTIFY_EMAIL || "")
// //   .split(",")
// //   .map((e) => e.trim())
// //   .filter(Boolean);

// // const SMTP_CONFIGURED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
// // const LEAD_EMAIL_READY = SMTP_CONFIGURED && LEAD_NOTIFY_EMAIL.length > 0;

// // let mailTransporter = null;
// // if (SMTP_CONFIGURED) {
// //   mailTransporter = nodemailer.createTransport({
// //     host: SMTP_HOST,
// //     port: SMTP_PORT,
// //     secure: SMTP_SECURE, // true for port 465, false for 587/STARTTLS
// //     auth: { user: SMTP_USER, pass: SMTP_PASS },
// //   });

// //   mailTransporter.verify().then(
// //     () => console.log("[Mail] SMTP connection verified — lead emails will send."),
// //     (err) => console.error("[Mail] SMTP verification failed:", err?.message || err)
// //   );
// // } else {
// //   console.warn(
// //     "[Mail] SMTP not fully configured (SMTP_HOST/SMTP_USER/SMTP_PASS) — lead emails will NOT be sent, leads are still stored in-memory on the session."
// //   );
// // }

// // if (SMTP_CONFIGURED && LEAD_NOTIFY_EMAIL.length === 0) {
// //   console.warn(
// //     "[Mail] LEAD_NOTIFY_EMAIL is not set — SMTP is configured but there is no recipient for lead emails."
// //   );
// // }

// // // ─────────────────────────────────────────────────────────────────────────────
// // // In-memory session store (replace with a database in production)
// // // ─────────────────────────────────────────────────────────────────────────────

// // /**
// //  * sessions: Map<sessionId, {
// //  *   messages: [],
// //  *   language: string,
// //  *   uploads: [{ filename, originalName, mimeType, path, uploadedAt }],
// //  *   userTurns: number,
// //  *   handoverRequested: boolean,   // true once the AI has nudged / limit hit
// //  *   handoverSubmitted: boolean,   // true once contact details were captured
// //  *   leadContact: { name, phone, email, notes, submittedAt } | null,
// //  *   createdAt: Date,
// //  *   updatedAt: Date
// //  * }>
// //  * Each message: { role: "user" | "assistant" | "system", content: string }
// //  */
// // const sessions = new Map();

// // const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// // // Prune expired sessions every hour
// // setInterval(() => {
// //   const now = Date.now();
// //   let pruned = 0;
// //   for (const [id, session] of sessions.entries()) {
// //     if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
// //       sessions.delete(id);
// //       pruned++;
// //     }
// //   }
// //   if (pruned > 0) {
// //     console.log(`[Sessions] Pruned ${pruned} expired sessions. Active: ${sessions.size}`);
// //   }
// // }, 60 * 60 * 1000);

// // // ─────────────────────────────────────────────────────────────────────────────
// // // System Prompt
// // // ─────────────────────────────────────────────────────────────────────────────
// // //
// // // NOTE ON ACCURACY: this prompt cannot make the underlying model "know"
// // // current Australian vehicle availability or pricing — GPT-4 has no live
// // // data source connected here. What it CAN do is stop the model from
// // // stating unverified specifics with false confidence, and route those
// // // questions to a human instead. If you need the bot to reliably quote
// // // real AU pricing/availability, that requires wiring in a live inventory
// // // or pricing feed (see the /api/chat/message handler comments below for
// // // where that would plug in).

// // const SYSTEM_PROMPT = `You are the Buy My Next Car AI Concierge — a vehicle buying consultant for Buy My Next Car (Australia). You are not a general-purpose assistant; you represent Buy My Next Car in every reply and never break that role.

// // ## Key Message (use this framing whenever timing, speed, or "is this real" comes up)
// // Our promise is: **"Instant conversation. Human-verified answers."** Chatting with you right now is instant — but any concrete number (a price, a repayment figure, a trade-in value, a finance outcome, stock availability) is always confirmed by a real person on our team before it's final. Be upfront about this distinction when it's relevant — it builds trust. Example: "I can get everything moving with you right now, but the actual price and repayment figures are always confirmed by one of our specialists — that way you're never quoted something that changes later."

// // ## Identity Rules (strict)
// // - NEVER say "As an AI", "As a language model", "I'm an AI assistant", or similar. You are the Buy My Next Car Concierge.
// // - NEVER say "I can't", "I'm unable to", "I don't have the ability to". Instead, always speak in terms of what Buy My Next Car (or "our team"/"our specialists") will do for the customer.
// //   - Instead of "I can't check that" → "We'll check that for you."
// //   - Instead of "I'm unable to give a valuation" → "One of our specialists will review that and get back to you with an estimate."
// //   - Instead of "I can't analyse images" → "Thanks, we've received that — one of our specialists will review it."
// // - Never send a customer away to an external site or third party. Never say "check RedBook", "speak to your bank", "contact the dealer/manufacturer". Instead:
// //   - "We can help with that."
// //   - "We'll organise that for you."
// //   - "One of our specialists will review that."
// //   - "Let's work through it together."

// // ## Company & Compliance Details (state exactly as written if asked — never guess or invent different numbers)
// // ${COMPANY.tradingAs} is operated by **${COMPANY.legalName}** (ABN ${COMPANY.abn}, ACN ${COMPANY.acn}), a ${COMPANY.companyType.toLowerCase()} registered with the ${COMPANY.regulator}, with its registered office in ${COMPANY.registeredOfficeLocality}. If a customer asks for the ABN, ACN, or legal entity name, give these exact details. For anything beyond entity identity — finance credit-licence numbers, credit representative numbers, the Privacy Policy, Terms, Credit Guide, or the complaints process — say a specialist will provide that; do not invent numbers or links that weren't given to you.

// // ## Personality
// // - Warm, confident, professional — like an experienced car buying consultant, not a search engine.
// // - Australian English ("ute" not "pickup truck", "petrol" not "gas").
// // - SHORT, conversational responses. 1–3 sentences per turn where possible. Avoid walls of text and avoid over-explaining.
// // - Ask ONE, at most TWO, questions per message. Never bundle a long list of questions at once.
// // - Always acknowledge what the customer just told you before moving on, briefly — don't just fire off the next question.
// // - You are consultative, not reactive: don't just answer and stop. Every reply should also move the conversation forward — toward an enquiry, a finance pre-assessment, a trade valuation, or a purchase.

// // ## MARKET LOCK — Australia Only (critical, non-negotiable)
// // This service exclusively supports the Australian new and used vehicle market. You do not have live access to current Australian vehicle inventory, specifications, or pricing — but regardless of confidence level, every vehicle, model, trim, spec, price, or availability claim you make must relate to Australia and nowhere else.

// // - NEVER mention, imply, or draw on overseas model names, trims, badge names, specs, or pricing (US-only trims, UK/NZ/Euro-market variants, JDM-only models, or anything not confirmed sold in Australia) — not even as a comparison point. Vehicle line-ups and trim names differ significantly by market — a model or trim that exists overseas may not exist here, or may be badged completely differently.
// // - If a customer asks about vehicles, pricing, or availability in another country (US, UK, NZ, Europe, Japan, etc.), or asks you to compare Australian figures to an overseas market, do not answer with overseas figures. Briefly and warmly explain you only cover the Australian market, and pivot to helping them with the Australian equivalent instead: "We're an Australian-market service, so I'll keep us focused on what's available here — let's find the local equivalent for you."
// // - If a customer states an overseas fact themselves and asks you to confirm, use, or compare against it, do not validate or adopt it. Say you can only speak to the Australian market and a specialist will confirm anything Australia-specific.
// // - Treat anything specific (a model being on sale in Australia, an exact price, a spec figure, a safety rating) as something you must NOT state with confidence unless it is extremely well-established and unlikely to have changed.
// // - If you are not confident a specific model, variant, trim, spec, or price is currently correct AND specific to the Australian market, say so plainly and route to a human, e.g.: "I don't want to give you the wrong figure there — I'll get one of our specialists to confirm the latest pricing and availability for you." Then keep the conversation moving (ask the next qualifying question, or ask if they'd like the team to follow up).
// // - NEVER invent or guess a price, spec, availability detail, or safety rating to fill a gap. A vague-but-honest answer is always better than a confident wrong one.
// // - When a customer corrects you (e.g. tells you a model isn't available, or a price is wrong), do NOT simply accept it and repeat it back as fact. Acknowledge it, and say the team will confirm/verify: "Thanks for flagging that — I'll make sure that's confirmed with the latest info before we go further." Do not adopt customer-supplied facts into later recommendations as if verified.
// // - Prefer talking about vehicle categories, budgets, and what the customer needs over naming very specific current-year variants/trims you can't verify. General, market-agnostic guidance (SUV vs ute, EV vs petrol, budget ranges, body styles) is fine to speak on confidently — that's not a fact that can be wrong. As soon as it needs a named model, trim, spec sheet, or price, hand it to a specialist rather than guessing.

// // ## Wording You Must Not Use
// // Some phrases carry legal/compliance weight and must only be used if they are actually true for us — never use them as filler or to sound impressive. Use the safer alternative instead:
// // - Don't say "licensed finance broker" → say "our finance specialists" / "our finance team"
// // - Don't say "pre-approval in seconds" or promise a speed/outcome for finance → say "an indicative assessment" / "we'll get that reviewed for you"
// // - Don't say "soft credit check" or describe the credit check type at all → simply say "our team will talk you through the assessment process"
// // - Don't say "5-star ANCAP verified" or state any ANCAP/safety rating for a specific vehicle → don't mention ANCAP ratings; if asked, say a specialist will confirm current safety ratings
// // - Don't say "100% protected", "guaranteed approval", or any absolute/unconditional promise → avoid absolute claims; describe what we do ("we'll work through options with you") rather than guaranteeing an outcome

// // ## How We Get Paid (if a customer asks)
// // Be upfront and simple: we don't charge the customer — we're paid by the dealer or lender once a vehicle purchase (or finance settlement) actually goes through. So chatting with us, getting a trade valuation, or getting a finance pre-assessment costs the customer nothing either way. If asked for more detail than that, say one of the team can explain fully.

// // ## Your Core Role
// // 1. **Vehicle Consultant**: Understand what the customer actually needs (budget, use case, new/used, body type, must-haves) before recommending anything. Ask qualifying questions rather than dumping a list of cars.
// // 2. **Finance Pre-Assessment Guide**: Walk customers through a natural, conversational finance qualification — not a form.
// // 3. **Trade Valuation Concierge**: Collect the details needed for a specialist to prepare an estimated trade value — never send customers to RedBook or similar.
// // 4. **Multi-language**: Converse in English, Mandarin (中文), Arabic (العربية), Hindi (हिन्दी), and others as needed.

// // ## Collecting Contact Details (required before any handover)
// // Before wrapping up a trade-in, finance, or vehicle-search conversation, make sure you have the customer's name and at least one way to reach them (phone or email) — a specialist needs this to actually follow up. Ask for it naturally once you've built some rapport and momentum, not as the very first question.

// // ## FINANCE CONVERSATION — natural, one/two questions at a time
// // When a customer wants finance or wants to buy with finance, guide them through gathering (don't dump these as a list — ask conversationally, one or two at a time, acknowledging each answer):
// // 1. New or used vehicle?
// // 2. Purchase price / budget range
// // 3. Deposit amount (if any)
// // 4. Trade-in vehicle (yes/no — if yes, move into the Trade Valuation flow below)
// // 5. Approximate annual income
// // 6. Home owner or renting?
// // 7. Business or personal purchase?
// // 8. Full name, and best contact details (email/phone) once they're clearly progressing

// // You do NOT ask for an interest rate or run a hard credit check — you are collecting what's needed for a pre-assessment. Once you have enough, say something like: "That's everything we need for now — I'll pass this to one of our finance specialists, and they'll be in touch shortly to take it further." Always note, once, that any figures discussed are indicative only and final approval sits with our finance team — keep this brief, don't repeat it every message.

// // If a customer's borrowing need looks very small (e.g. clearly a few thousand dollars) or their situation clearly falls outside typical vehicle finance (e.g. no income at all), don't reject them outright yourself — say the team will confirm what options are available: "Let's get this in front of our finance team — they'll confirm what options are available for your situation."

// // ## TRADE VALUATION — never send them to RedBook or anywhere else
// // If a customer wants to know what their current car is worth, or mentions a trade-in, collect (conversationally, one/two at a time):
// // - Registration number (or make/model/year if they don't have rego handy)
// // - Odometer reading
// // - Service history (dealer serviced, logbooks, any major work)
// // - Condition notes (any damage, tyres, etc.)
// // - Photos (see below)
// // - Name and best contact number or email, once you're a little way into the conversation

// // Then say: "Thanks — I'll get one of our specialists to review this and come back with an estimated trade value." Never quote a specific trade-in figure yourself.

// // ## PHOTO / IMAGE HANDLING
// // If the customer has uploaded, or offers to upload, photos (of their trade-in vehicle, damage, odometer, etc.), encourage it — photos help the specialist give a more accurate estimate. Once photos are received, confirm receipt warmly and say a Buy My Next Car specialist will review them as part of the valuation/assessment. Do not say you are analysing the images yourself, and do not describe their contents — simply confirm they've been received and will be reviewed by the team.

// // ## After Qualification (finance or trade)
// // - Briefly summarise what you've captured.
// // - Explain next steps in terms of "our team"/"a specialist" following up — give a timeframe if one is set (e.g. "within 24 hours") only if that's accurate for your operation; otherwise say "shortly".
// // - Thank them.

// // ## Response Style
// // - Short and conversational. 1–3 sentences most of the time.
// // - One or two questions max per message.
// // - Minimal markdown — light use of **bold** for key words is fine, avoid heavy formatting, headers, or long bullet lists in normal conversation (bullet lists are fine when actually presenting a short set of options).
// // - Never repeat the same disclaimer more than once in a conversation.
// // - Every message should either qualify the customer, build trust, collect useful information, or move them toward an enquiry, finance pre-assessment, trade valuation, or purchase.`;

// // // System-message nudge injected once a session crosses the turn limit, so
// // // the AI proactively wraps up and pushes toward human handover instead of
// // // the conversation just running indefinitely.
// // const HANDOFF_NUDGE = `IMPORTANT — this conversation has now covered a good amount of ground. In your NEXT reply: briefly (1-2 sentences) summarise what you've learned so far, let the customer know a specialist will now take it from here for anything needing a verified price, availability, or finance figure, and invite them to pop in their name and best phone number or email (if you don't already have both) so the team can reach them directly. Keep it warm, not abrupt.`;

// // // ─────────────────────────────────────────────────────────────────────────────
// // // Express App Setup
// // // ─────────────────────────────────────────────────────────────────────────────

// // const app = express();

// // app.use(
// //   cors({
// //     origin: ALLOWED_ORIGINS.includes("*")
// //       ? "*"
// //       : (origin, cb) => {
// //           if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
// //           else cb(new Error(`Origin ${origin} not allowed`));
// //         },
// //     methods: ["GET", "POST", "OPTIONS"],
// //     allowedHeaders: ["Content-Type", "Authorization"],
// //   })
// // );

// // app.use(express.json({ limit: "1mb" }));

// // // ─────────────────────────────────────────────────────────────────────────────
// // // Serve the widget assets (iife.js / iife.css) from this same server, so
// // // https://buycarbot.omnisuiteai.com/iife.js and
// // // https://buycarbot.omnisuiteai.com/iife.css resolve directly.
// // //
// // // Only files inside ./public are exposed — index.js, .env, package.json,
// // // uploaded photos, etc. are never reachable over HTTP. Put iife.js and
// // // iife.css inside a "public" folder next to this file.
// // // ─────────────────────────────────────────────────────────────────────────────

// // app.use(
// //   express.static(path.join(__dirname, "public"), {
// //     index: false, // don't auto-serve index.html for "/"
// //     setHeaders: (res, filePath) => {
// //       if (filePath.endsWith(".js") || filePath.endsWith(".css")) {
// //         // Widget assets change with deploys; allow short caching, not "forever".
// //         res.setHeader("Cache-Control", "public, max-age=300");
// //       }
// //     },
// //   })
// // );

// // // ─────────────────────────────────────────────────────────────────────────────
// // // Photo upload (trade valuations, etc.)
// // // ─────────────────────────────────────────────────────────────────────────────

// // const upload = multer({
// //   storage: multer.diskStorage({
// //     destination: (req, _file, cb) => cb(null, UPLOAD_DIR),
// //     filename: (req, file, cb) => {
// //       const sessionId = (req.body && req.body.sessionId) || "unknown-session";
// //       const safeSession = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
// //       const ext = path.extname(file.originalname || "").slice(0, 10);
// //       cb(null, `${safeSession}_${Date.now()}_${uuidv4()}${ext}`);
// //     },
// //   }),
// //   limits: { fileSize: 8 * 1024 * 1024, files: 6 }, // 8MB per file, up to 6 files
// //   fileFilter: (_req, file, cb) => {
// //     const okTypes = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
// //     cb(null, okTypes.includes(file.mimetype));
// //   },
// // });

// // // ─────────────────────────────────────────────────────────────────────────────
// // // Request validation helpers
// // // ─────────────────────────────────────────────────────────────────────────────

// // function validateMessage(msg) {
// //   if (!msg || typeof msg !== "string") return false;
// //   const trimmed = msg.trim();
// //   return trimmed.length >= 1 && trimmed.length <= 5000;
// // }

// // function validateLanguage(lang) {
// //   const allowed = ["English", "Mandarin", "Arabic", "Hindi"];
// //   return !lang || allowed.includes(lang) ? lang || "English" : "English";
// // }

// // function getOrCreateSession(incomingSessionId, language) {
// //   let sessionId = incomingSessionId;
// //   let session;
// //   if (sessionId && sessions.has(sessionId)) {
// //     session = sessions.get(sessionId);
// //     session.updatedAt = new Date();
// //   } else {
// //     sessionId = uuidv4();
// //     session = {
// //       messages: [],
// //       language,
// //       uploads: [],
// //       userTurns: 0,
// //       handoverRequested: false,
// //       handoverSubmitted: false,
// //       leadContact: null,
// //       createdAt: new Date(),
// //       updatedAt: new Date(),
// //     };
// //     sessions.set(sessionId, session);
// //   }
// //   return { sessionId, session };
// // }

// // function recordUserTurn(session) {
// //   session.userTurns = (session.userTurns || 0) + 1;
// // }

// // /**
// //  * Calls OpenAI with the session's history, optionally injecting the
// //  * handoff nudge as an extra system message.
// //  */
// // async function getAssistantReply(session, language, { nudgeHandoff = false } = {}) {
// //   const llmMessages = [{ role: "system", content: SYSTEM_PROMPT }];

// //   if (language && language !== "English") {
// //     llmMessages.push({
// //       role: "system",
// //       content: `The user has selected ${language} as their preferred language. Please respond in ${language} from now on.`,
// //     });
// //   }

// //   if (nudgeHandoff) {
// //     llmMessages.push({ role: "system", content: HANDOFF_NUDGE });
// //   }

// //   // TODO (accuracy fix): this is where a live inventory/pricing feed or a
// //   // curated AU vehicle spec sheet would be looked up and injected as an
// //   // additional system message. Without this, the model is relying on
// //   // training data only — see the note above SYSTEM_PROMPT.
// //   //
// //   // TODO (market lock): if/when a real inventory or pricing feed is wired
// //   // in here, make sure the feed query itself is scoped to Australia
// //   // (e.g. country=AU / market=AU) rather than relying on the prompt alone
// //   // to filter out overseas results — the prompt instruction above is the
// //   // only enforcement currently in place, since there is no live database
// //   // connected to this backend.

// //   // Include last 30 messages to stay within context limits
// //   const history = session.messages.slice(-30);
// //   for (const msg of history) {
// //     // "system" role messages we injected (e.g. photo-received notices) are
// //     // included as-is so the model knows about them without them showing
// //     // up as something the user typed.
// //     llmMessages.push({ role: msg.role, content: msg.content });
// //   }

// //   const completion = await openai.chat.completions.create({
// //     model: "gpt-4",
// //     messages: llmMessages,
// //     max_tokens: 700,
// //     temperature: 0.6,
// //   });

// //   return (
// //     completion.choices?.[0]?.message?.content ||
// //     "Sorry, that didn't come through properly on our end — could you try sending that again?"
// //   );
// // }

// // function escapeHtml(str) {
// //   return String(str || "")
// //     .replace(/&/g, "&amp;")
// //     .replace(/</g, "&lt;")
// //     .replace(/>/g, "&gt;");
// // }

// // /**
// //  * Builds a readable HTML transcript of the conversation for the lead email.
// //  * System-injected notes (e.g. "customer uploaded photos") are shown as a
// //  * neutral note rather than under either avatar.
// //  */
// // function renderTranscriptHtml(messages) {
// //   return messages
// //     .map((m) => {
// //       const who = m.role === "assistant" ? "Buy My Next Car AI" : m.role === "system" ? "Note" : "Customer";
// //       const bg = m.role === "assistant" ? "#EFF6FF" : m.role === "system" ? "#F3F4F6" : "#F5F0E8";
// //       return `<div style="margin:0 0 10px;padding:10px 14px;background:${bg};border-radius:10px;">
// //         <div style="font-size:11px;font-weight:600;color:#2C3338;margin-bottom:4px;">${who}</div>
// //         <div style="font-size:13px;color:#2C3338;white-space:pre-wrap;">${escapeHtml(m.content)}</div>
// //       </div>`;
// //     })
// //     .join("");
// // }

// // /**
// //  * Emails a captured lead (contact details, conversation transcript, and any
// //  * uploaded trade-in photos as attachments, read straight off UPLOAD_DIR) to
// //  * LEAD_NOTIFY_EMAIL over SMTP. This is the human-handover point — a real
// //  * team member receives this and follows up with verified pricing,
// //  * availability, or finance details. Failures here are logged but never
// //  * block the customer-facing response.
// //  */
// // async function notifyLeadByEmail(sessionId, session, contact) {
// //   if (!LEAD_EMAIL_READY) {
// //     console.log(
// //       `[Handover] Email not configured (SMTP + LEAD_NOTIFY_EMAIL) — lead for session ${sessionId} stored in-memory only.`
// //     );
// //     return;
// //   }

// //   const subject = `New lead — Buy My Next Car — ${contact.name}`;

// //   const html = `
// //     <div style="font-family:Arial,sans-serif;max-width:640px;">
// //       <h2 style="color:#2563EB;margin-bottom:4px;">New chat lead</h2>
// //       <p style="color:#6B7280;margin-top:0;">Session ${escapeHtml(sessionId)} · ${escapeHtml(
// //     session.language || "English"
// //   )}</p>

// //       <table style="width:100%;border-collapse:collapse;margin:16px 0;">
// //         <tr><td style="padding:4px 0;font-weight:600;width:110px;">Name</td><td>${escapeHtml(contact.name)}</td></tr>
// //         <tr><td style="padding:4px 0;font-weight:600;">Phone</td><td>${escapeHtml(contact.phone || "—")}</td></tr>
// //         <tr><td style="padding:4px 0;font-weight:600;">Email</td><td>${escapeHtml(contact.email || "—")}</td></tr>
// //         <tr><td style="padding:4px 0;font-weight:600;vertical-align:top;">Notes</td><td>${escapeHtml(
// //           contact.notes || "—"
// //         )}</td></tr>
// //         <tr><td style="padding:4px 0;font-weight:600;">Photos</td><td>${session.uploads.length} attached${
// //     session.uploads.length ? " below" : ""
// //   }</td></tr>
// //       </table>

// //       <h3 style="color:#2C3338;margin-bottom:8px;">Conversation</h3>
// //       ${renderTranscriptHtml(session.messages)}

// //       <p style="color:#9CA3AF;font-size:11px;margin-top:20px;">
// //         Indicative guidance only — confirm all pricing, availability, trade value and finance figures with the customer directly.
// //       </p>
// //     </div>
// //   `;

// //   // nodemailer can attach directly from disk via `path` — no need to
// //   // manually read the files back into memory first.
// //   const attachments = session.uploads
// //     .filter((u) => fs.existsSync(u.path))
// //     .map((u, idx) => ({
// //       filename: u.originalName || `trade-in-photo-${idx + 1}.jpg`,
// //       path: u.path,
// //       contentType: u.mimeType,
// //     }));

// //   try {
// //     await mailTransporter.sendMail({
// //       from: LEAD_NOTIFY_FROM,
// //       to: LEAD_NOTIFY_EMAIL.join(","),
// //       subject,
// //       html,
// //       attachments,
// //     });
// //     console.log(`[Mail] Lead email sent for session ${sessionId} to ${LEAD_NOTIFY_EMAIL.join(", ")}`);
// //   } catch (err) {
// //     console.error("[Mail] Failed to send lead email:", err?.message || err);
// //   }
// // }

// // // ─────────────────────────────────────────────────────────────────────────────
// // // Routes
// // // ─────────────────────────────────────────────────────────────────────────────

// // /**
// //  * GET /health
// //  */
// // app.get("/health", (_req, res) => {
// //   res.json({
// //     ok: true,
// //     activeSessions: sessions.size,
// //     timestamp: new Date().toISOString(),
// //   });
// // });

// // /**
// //  * POST /api/chat/message
// //  * Body: { sessionId?: string, message: string, language?: string }
// //  * Returns: { sessionId, message, conversationLength, handoffRequired, handoffSubmitted }
// //  */
// // app.post("/api/chat/message", async (req, res) => {
// //   const { sessionId: incomingSessionId, message, language: rawLanguage } = req.body;

// //   // Validate
// //   if (!validateMessage(message)) {
// //     return res.status(400).json({
// //       error: "Invalid message. Must be a non-empty string up to 5000 characters.",
// //     });
// //   }

// //   const language = validateLanguage(rawLanguage);
// //   const { sessionId, session } = getOrCreateSession(incomingSessionId, language);

// //   // Add user message
// //   session.messages.push({ role: "user", content: message });
// //   recordUserTurn(session);

// //   const shouldNudgeHandoff =
// //     !session.handoverRequested && session.userTurns >= MAX_USER_TURNS_BEFORE_HANDOFF;

// //   // Call OpenAI
// //   let assistantContent;
// //   try {
// //     assistantContent = await getAssistantReply(session, language, {
// //       nudgeHandoff: shouldNudgeHandoff,
// //     });
// //   } catch (err) {
// //     console.error("[OpenAI] API error:", err?.message || err);

// //     const status = err?.status;
// //     if (status === 429) {
// //       return res.status(429).json({
// //         error: "Our system's a little busy right now — please try again in a moment.",
// //       });
// //     }
// //     if (status === 401) {
// //       return res.status(500).json({ error: "We're having a technical issue on our end. Please try again shortly." });
// //     }

// //     return res.status(500).json({
// //       error: "We're having trouble connecting right now. Please try again in a moment.",
// //     });
// //   }

// //   if (shouldNudgeHandoff) {
// //     session.handoverRequested = true;
// //     console.log(
// //       `[Handoff] sessionId=${sessionId} reached ${session.userTurns} turns — nudged toward human handover.`
// //     );
// //   }

// //   // Save assistant response
// //   session.messages.push({ role: "assistant", content: assistantContent });

// //   console.log(
// //     `[Chat] sessionId=${sessionId} lang=${language} msgCount=${session.messages.length}`
// //   );

// //   return res.json({
// //     sessionId,
// //     message: assistantContent,
// //     conversationLength: session.messages.length,
// //     handoffRequired: session.handoverRequested,
// //     handoffSubmitted: session.handoverSubmitted,
// //   });
// // });

// // /**
// //  * POST /api/chat/upload
// //  * multipart/form-data: sessionId (text field), photos (one or more files)
// //  * Returns: { sessionId, uploaded: number, message }
// //  *
// //  * Stores photos privately (see UPLOAD_DIR) so they can be attached to the
// //  * lead email once the customer submits their details via /api/chat/handover.
// //  * Also drops a system note into the session so the assistant knows photos
// //  * came in and can acknowledge them, without claiming to have analysed them
// //  * itself.
// //  */
// // app.post("/api/chat/upload", upload.array("photos", 6), (req, res) => {
// //   const incomingSessionId = req.body && req.body.sessionId;
// //   const language = validateLanguage(req.body && req.body.language);

// //   if (!req.files || req.files.length === 0) {
// //     return res.status(400).json({ error: "No photos were received." });
// //   }

// //   const { sessionId, session } = getOrCreateSession(incomingSessionId, language);

// //   const uploadRecords = req.files.map((f) => ({
// //     filename: f.filename,
// //     originalName: f.originalname,
// //     mimeType: f.mimetype,
// //     path: f.path,
// //     uploadedAt: new Date(),
// //   }));
// //   session.uploads.push(...uploadRecords);
// //   session.updatedAt = new Date();

// //   session.messages.push({
// //     role: "system",
// //     content: `[System note: the customer just uploaded ${req.files.length} photo(s) for their trade valuation/assessment. Total photos so far: ${session.uploads.length}. Acknowledge receipt warmly and let them know a Buy My Next Car specialist will review the photos. Do not claim to have analysed the images yourself, and do not guess at their contents.]`,
// //   });

// //   console.log(`[Upload] sessionId=${sessionId} files=${uploadRecords.length} totalUploads=${session.uploads.length}`);

// //   return res.json({
// //     sessionId,
// //     uploaded: req.files.length,
// //     message: "Photos received.",
// //   });
// // });

// // /**
// //  * POST /api/chat/handover
// //  * Body: { sessionId: string, name: string, phone?: string, email?: string, notes?: string }
// //  *
// //  * This is the human-handover step: the customer submits their contact
// //  * details (plus anything else they typed in — e.g. "call after 5pm") so a
// //  * real team member can pick up the conversation, confirm pricing/finance/
// //  * trade figures, and follow up. The lead — including the full transcript
// //  * and any uploaded trade-in photos as attachments — is emailed to
// //  * LEAD_NOTIFY_EMAIL via SMTP if configured (see config at top of file).
// //  *
// //  * Returns: { success, message }
// //  */
// // app.post("/api/chat/handover", async (req, res) => {
// //   const { sessionId, name, phone, email, notes } = req.body;

// //   if (!sessionId || typeof sessionId !== "string" || !sessions.has(sessionId)) {
// //     return res.status(400).json({
// //       error: "We couldn't find that conversation — please send a message in the chat first.",
// //     });
// //   }

// //   if (!name || typeof name !== "string" || !name.trim()) {
// //     return res.status(400).json({ error: "Please include your name." });
// //   }

// //   const hasPhone = typeof phone === "string" && phone.trim().length > 0;
// //   const hasEmail = typeof email === "string" && email.trim().length > 0;
// //   if (!hasPhone && !hasEmail) {
// //     return res.status(400).json({
// //       error: "Please include a phone number or email so our team can reach you.",
// //     });
// //   }

// //   const session = sessions.get(sessionId);

// //   const contact = {
// //     name: name.trim().slice(0, 200),
// //     phone: hasPhone ? phone.trim().slice(0, 50) : "",
// //     email: hasEmail ? email.trim().slice(0, 200) : "",
// //     notes: typeof notes === "string" ? notes.trim().slice(0, 1000) : "",
// //     submittedAt: new Date(),
// //   };

// //   session.leadContact = contact;
// //   session.handoverSubmitted = true;
// //   session.handoverRequested = true;
// //   session.updatedAt = new Date();

// //   session.messages.push({
// //     role: "user",
// //     content: `[Customer submitted their details for specialist follow-up — name: ${contact.name}, phone: ${
// //       contact.phone || "—"
// //     }, email: ${contact.email || "—"}${contact.notes ? `, notes: "${contact.notes}"` : ""}]`,
// //   });

// //   await notifyLeadByEmail(sessionId, session, contact);

// //   console.log(
// //     `[Handover] sessionId=${sessionId} name=${contact.name} photos=${session.uploads.length} email=${
// //       LEAD_EMAIL_READY ? "sent" : "not configured"
// //     }`
// //   );

// //   return res.json({
// //     success: true,
// //     message:
// //       "Thanks — that's with our team now. A specialist will be in touch with verified pricing, availability or finance details shortly.",
// //   });
// // });

// // /**
// //  * POST /api/chat/reset
// //  * Body: { sessionId: string }
// //  */
// // app.post("/api/chat/reset", (req, res) => {
// //   const { sessionId } = req.body;

// //   if (!sessionId || typeof sessionId !== "string") {
// //     return res.status(400).json({ error: "sessionId is required." });
// //   }

// //   if (sessions.has(sessionId)) {
// //     const session = sessions.get(sessionId);

// //     // Best-effort cleanup of any uploaded photos on disk — non-blocking,
// //     // failures are logged but never surfaced to the customer.
// //     for (const u of session.uploads) {
// //       fs.unlink(u.path, (err) => {
// //         if (err) console.warn(`[Reset] Could not remove upload ${u.path}:`, err.message);
// //       });
// //     }

// //     session.messages = [];
// //     session.uploads = [];
// //     session.userTurns = 0;
// //     session.handoverRequested = false;
// //     session.handoverSubmitted = false;
// //     session.leadContact = null;
// //     session.updatedAt = new Date();
// //     console.log(`[Chat] Session reset: ${sessionId}`);
// //   }

// //   return res.json({ success: true });
// // });

// // /**
// //  * GET /api/chat/session/:sessionId
// //  */
// // app.get("/api/chat/session/:sessionId", (req, res) => {
// //   const { sessionId } = req.params;
// //   const session = sessions.get(sessionId);

// //   if (!session) {
// //     return res.status(404).json({ error: "Session not found." });
// //   }

// //   return res.json({
// //     sessionId,
// //     messages: session.messages,
// //     language: session.language,
// //     uploads: session.uploads.map(({ filename, originalName, mimeType, uploadedAt }) => ({
// //       filename,
// //       originalName,
// //       mimeType,
// //       uploadedAt,
// //     })),
// //     handoffRequired: session.handoverRequested,
// //     handoffSubmitted: session.handoverSubmitted,
// //     createdAt: session.createdAt,
// //     updatedAt: session.updatedAt,
// //   });
// // });

// // // ─────────────────────────────────────────────────────────────────────────────
// // // Error handler
// // // ─────────────────────────────────────────────────────────────────────────────

// // app.use((err, _req, res, _next) => {
// //   console.error("[Server Error]", err);
// //   if (err && err.message && err.message.includes("not allowed")) {
// //     return res.status(403).json({ error: "Origin not allowed." });
// //   }
// //   res.status(500).json({ error: "Internal server error." });
// // });

// // // ─────────────────────────────────────────────────────────────────────────────
// // // Start
// // // ─────────────────────────────────────────────────────────────────────────────

// // app.listen(PORT, () => {
// //   console.log(`\n🚗 Buy My Next Car — Chatbot Backend`);
// //   console.log(`   Local:  http://localhost:${PORT}`);
// //   console.log(`   Public: https://buycarbot.omnisuiteai.com`);
// //   console.log(`   Widget assets:`);
// //   console.log(`     https://buycarbot.omnisuiteai.com/iife.js`);
// //   console.log(`     https://buycarbot.omnisuiteai.com/iife.css`);
// //   console.log(`   Model: gpt-4`);
// //   console.log(`   Uploads dir (private): ${UPLOAD_DIR}`);
// //   console.log(`   Market: Australia only`);
// //   console.log(`   Operating entity: ${COMPANY.legalName} — ABN ${COMPANY.abn} / ACN ${COMPANY.acn}`);
// //   console.log(`   Handoff threshold: ${MAX_USER_TURNS_BEFORE_HANDOFF} customer turns`);
// //   console.log(
// //     `   Lead emails: ${
// //       LEAD_EMAIL_READY ? `${LEAD_NOTIFY_FROM} → ${LEAD_NOTIFY_EMAIL.join(", ")}` : "not configured"
// //     }`
// //   );
// //   console.log(`   Sessions: in-memory (replace with DB for production)\n`);
// // });
// require("dotenv").config();

// const path = require("path");
// const fs = require("fs");
// const express = require("express");
// const cors = require("cors");
// const { v4: uuidv4 } = require("uuid");
// const OpenAI = require("openai");
// const multer = require("multer");
// const nodemailer = require("nodemailer");
// const mongoose = require("mongoose");

// // ─────────────────────────────────────────────────────────────────────────────
// // Configuration
// // ─────────────────────────────────────────────────────────────────────────────

// const PORT = process.env.PORT || 4099;
// const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// const MONGODB_URI = process.env.MONGODB_URI;

// const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
//   ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
//   : ["*"];

// const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads-private");
// if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// // Temp dir for KB file uploads — files are deleted immediately after text extraction.
// const KB_UPLOAD_DIR = path.join(__dirname, "kb-uploads-private");
// if (!fs.existsSync(KB_UPLOAD_DIR)) fs.mkdirSync(KB_UPLOAD_DIR, { recursive: true });

// const MAX_USER_TURNS_BEFORE_HANDOFF = parseInt(
//   process.env.MAX_USER_TURNS_BEFORE_HANDOFF || "14",
//   10
// );

// // Per-entry and total char caps to stay within GPT-4 context limits.
// const KB_MAX_CHARS_PER_ENTRY = 100_000; // ~25 k tokens
// const KB_MAX_TOTAL_CHARS = 400_000;     // cumulative across all entries

// const COMPANY = {
//   legalName: "Test Drive Group Pty Ltd",
//   tradingAs: "Buy My Next Car",
//   abn: "51 679 064 343",
//   acn: "679 064 343",
//   companyType: "Australian Proprietary Company, Limited By Shares",
//   registrationDate: "12/07/2024",
//   status: "Registered",
//   registeredOfficeLocality: "Rowville VIC 3178",
//   regulator: "Australian Securities & Investments Commission (ASIC)",
// };

// // ── Guard required env vars ──────────────────────────────────────────────────
// if (!OPENAI_API_KEY) {
//   console.error("[FATAL] OPENAI_API_KEY is not set.");
//   process.exit(1);
// }
// if (!MONGODB_URI) {
//   console.error("[FATAL] MONGODB_URI is not set. Add it to .env  e.g.  MONGODB_URI=mongodb+srv://...");
//   process.exit(1);
// }

// const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// // ── SMTP / Lead email ────────────────────────────────────────────────────────
// const SMTP_HOST = process.env.SMTP_HOST || "";
// const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465", 10);
// const SMTP_SECURE = String(process.env.SMTP_SECURE).toLowerCase() === "true";
// const SMTP_USER = process.env.SMTP_USER || "";
// const SMTP_PASS = process.env.SMTP_PASS || "";
// const LEAD_NOTIFY_FROM = process.env.LEAD_NOTIFY_FROM || SMTP_USER;
// const LEAD_NOTIFY_EMAIL = (process.env.LEAD_NOTIFY_EMAIL || "")
//   .split(",")
//   .map((e) => e.trim())
//   .filter(Boolean);

// const SMTP_CONFIGURED = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
// const LEAD_EMAIL_READY = SMTP_CONFIGURED && LEAD_NOTIFY_EMAIL.length > 0;

// let mailTransporter = null;
// if (SMTP_CONFIGURED) {
//   mailTransporter = nodemailer.createTransport({
//     host: SMTP_HOST,
//     port: SMTP_PORT,
//     secure: SMTP_SECURE,
//     auth: { user: SMTP_USER, pass: SMTP_PASS },
//   });
//   mailTransporter.verify().then(
//     () => console.log("[Mail] SMTP verified — lead emails will send."),
//     (err) => console.error("[Mail] SMTP verification failed:", err?.message || err)
//   );
// } else {
//   console.warn("[Mail] SMTP not configured — lead emails will NOT send.");
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // MongoDB connection
// // ─────────────────────────────────────────────────────────────────────────────

// mongoose.set("strictQuery", true);

// mongoose.connection.on("connected", () =>
//   console.log("[MongoDB] Connected to:", mongoose.connection.host)
// );
// mongoose.connection.on("error", (err) =>
//   console.error("[MongoDB] Connection error:", err.message)
// );
// mongoose.connection.on("disconnected", () =>
//   console.warn("[MongoDB] Disconnected — will auto-reconnect.")
// );

// // ─────────────────────────────────────────────────────────────────────────────
// // ★ KnowledgeEntry Mongoose model
// // ─────────────────────────────────────────────────────────────────────────────
// //
// // Collection: knowledgeentries
// // Fields:
// //   _id        ObjectId (auto)
// //   id         string   UUID — used as the public-facing identifier in API responses
// //   label      string   Human-readable name for this entry
// //   text       string   Extracted / pasted text content (the actual knowledge)
// //   source     string   "pdf" | "txt" | "free-text"
// //   charCount  number   Stored so listings are fast (no need to .length the text)
// //   addedAt    Date

// const knowledgeEntrySchema = new mongoose.Schema(
//   {
//     id:        { type: String, required: true, unique: true, index: true },
//     label:     { type: String, required: true, maxlength: 200 },
//     text:      { type: String, required: true },
//     source:    { type: String, enum: ["pdf", "txt", "free-text"], default: "free-text" },
//     charCount: { type: Number, required: true },
//   },
//   {
//     timestamps: { createdAt: "addedAt", updatedAt: false },
//     collection: "knowledgeentries",
//   }
// );

// const KnowledgeEntry = mongoose.model("KnowledgeEntry", knowledgeEntrySchema);

// // ─────────────────────────────────────────────────────────────────────────────
// // Knowledge-base helper functions
// // ─────────────────────────────────────────────────────────────────────────────

// /**
//  * Fetches ALL entries from MongoDB and builds the aggregated KB block that
//  * is injected into every OpenAI call.  Returns null when the KB is empty.
//  *
//  * For very large knowledge bases (thousands of entries) you would want to
//  * either cache this (invalidating on write/delete) or switch to a vector
//  * store with similarity search. For typical use-cases this is fast enough.
//  */
// async function buildKnowledgeBaseBlock() {
//   const entries = await KnowledgeEntry.find({}, "label text").lean();
//   if (!entries.length) return null;
//   return entries
//     .map((e) => `### ${e.label}\n\n${e.text}`)
//     .join("\n\n---\n\n");
// }

// /**
//  * Sum of charCount across all stored entries.
//  */
// async function kbTotalChars() {
//   const result = await KnowledgeEntry.aggregate([
//     { $group: { _id: null, total: { $sum: "$charCount" } } },
//   ]);
//   return result[0]?.total ?? 0;
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // In-memory session store
// // (Chat sessions are kept in-memory; only the knowledge base uses MongoDB.)
// // ─────────────────────────────────────────────────────────────────────────────

// const sessions = new Map();
// const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// setInterval(() => {
//   const now = Date.now();
//   let pruned = 0;
//   for (const [id, session] of sessions.entries()) {
//     if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
//       sessions.delete(id);
//       pruned++;
//     }
//   }
//   if (pruned > 0)
//     console.log(`[Sessions] Pruned ${pruned} expired sessions. Active: ${sessions.size}`);
// }, 60 * 60 * 1000);

// // ─────────────────────────────────────────────────────────────────────────────
// // System Prompt
// // ─────────────────────────────────────────────────────────────────────────────

// const SYSTEM_PROMPT = `You are the Buy My Next Car AI Concierge — a vehicle buying consultant for Buy My Next Car (Australia). You are not a general-purpose assistant; you represent Buy My Next Car in every reply and never break that role.

// ## Key Message (use this framing whenever timing, speed, or "is this real" comes up)
// Our promise is: **"Instant conversation. Human-verified answers."** Chatting with you right now is instant — but any concrete number (a price, a repayment figure, a trade-in value, a finance outcome, stock availability) is always confirmed by a real person on our team before it's final. Be upfront about this distinction when it's relevant — it builds trust. Example: "I can get everything moving with you right now, but the actual price and repayment figures are always confirmed by one of our specialists — that way you're never quoted something that changes later."

// ## Identity Rules (strict)
// - NEVER say "As an AI", "As a language model", "I'm an AI assistant", or similar. You are the Buy My Next Car Concierge.
// - NEVER say "I can't", "I'm unable to", "I don't have the ability to". Instead, always speak in terms of what Buy My Next Car (or "our team"/"our specialists") will do for the customer.
//   - Instead of "I can't check that" → "We'll check that for you."
//   - Instead of "I'm unable to give a valuation" → "One of our specialists will review that and get back to you with an estimate."
//   - Instead of "I can't analyse images" → "Thanks, we've received that — one of our specialists will review it."
// - Never send a customer away to an external site or third party. Never say "check RedBook", "speak to your bank", "contact the dealer/manufacturer". Instead:
//   - "We can help with that."
//   - "We'll organise that for you."
//   - "One of our specialists will review that."
//   - "Let's work through it together."

// ## Company & Compliance Details (state exactly as written if asked — never guess or invent different numbers)
// ${COMPANY.tradingAs} is operated by **${COMPANY.legalName}** (ABN ${COMPANY.abn}, ACN ${COMPANY.acn}), a ${COMPANY.companyType.toLowerCase()} registered with the ${COMPANY.regulator}, with its registered office in ${COMPANY.registeredOfficeLocality}. If a customer asks for the ABN, ACN, or legal entity name, give these exact details. For anything beyond entity identity — finance credit-licence numbers, credit representative numbers, the Privacy Policy, Terms, Credit Guide, or the complaints process — say a specialist will provide that; do not invent numbers or links that weren't given to you.

// ## Personality
// - Warm, confident, professional — like an experienced car buying consultant, not a search engine.
// - Australian English ("ute" not "pickup truck", "petrol" not "gas").
// - SHORT, conversational responses. 1–3 sentences per turn where possible. Avoid walls of text and avoid over-explaining.
// - Ask ONE, at most TWO, questions per message. Never bundle a long list of questions at once.
// - Always acknowledge what the customer just told you before moving on, briefly — don't just fire off the next question.
// - You are consultative, not reactive: don't just answer and stop. Every reply should also move the conversation forward — toward an enquiry, a finance pre-assessment, a trade valuation, or a purchase.

// ## MARKET LOCK — Australia Only (critical, non-negotiable)
// This service exclusively supports the Australian new and used vehicle market.
// - NEVER mention, imply, or draw on overseas model names, trims, badge names, specs, or pricing.
// - If a customer asks about vehicles or pricing in another country, briefly explain you only cover the Australian market and pivot to the local equivalent.
// - NEVER invent or guess a price, spec, availability detail, or safety rating. A vague-but-honest answer is always better than a confident wrong one.

// ## Wording You Must Not Use
// - Don't say "licensed finance broker" → say "our finance specialists" / "our finance team"
// - Don't say "pre-approval in seconds" or promise a speed/outcome for finance → say "an indicative assessment"
// - Don't say "soft credit check" or describe the credit check type at all
// - Don't say "5-star ANCAP verified" or state any ANCAP/safety rating for a specific vehicle
// - Don't say "100% protected", "guaranteed approval", or any absolute promise

// ## How We Get Paid (if a customer asks)
// We don't charge the customer — we're paid by the dealer or lender once a vehicle purchase or finance settlement goes through. Chatting, trade valuations, and finance pre-assessments are all free.

// ## Your Core Role
// 1. **Vehicle Consultant**: Understand what the customer actually needs before recommending anything.
// 2. **Finance Pre-Assessment Guide**: Walk customers through a natural, conversational finance qualification.
// 3. **Trade Valuation Concierge**: Collect the details needed for a specialist to prepare an estimated trade value.
// 4. **Multi-language**: Converse in English, Mandarin (中文), Arabic (العربية), Hindi (हिन्दी), and others as needed.

// ## Collecting Contact Details
// Before wrapping up any conversation, make sure you have the customer's name and at least one contact method (phone or email).

// ## FINANCE CONVERSATION — natural, one/two questions at a time
// Guide them through (conversationally): new or used? → budget? → deposit? → trade-in? → income? → home owner or renting? → business or personal? → contact details.

// ## TRADE VALUATION
// Collect: rego (or make/model/year), odometer, service history, condition, photos, name and contact. Never quote a figure yourself.

// ## PHOTO / IMAGE HANDLING
// Encourage photos for trade valuations. Confirm receipt warmly; say a specialist will review them. Do not claim to analyse images yourself.

// ## Response Style
// - Short and conversational. 1–3 sentences most of the time.
// - One or two questions max per message.
// - Minimal markdown — light **bold** is fine, avoid heavy formatting.
// - Never repeat the same disclaimer more than once in a conversation.`;

// const HANDOFF_NUDGE = `IMPORTANT — this conversation has now covered a good amount of ground. In your NEXT reply: briefly (1-2 sentences) summarise what you've learned so far, let the customer know a specialist will now take it from here, and invite them to share their name and best phone number or email so the team can reach them. Keep it warm, not abrupt.`;

// // ─────────────────────────────────────────────────────────────────────────────
// // Express App
// // ─────────────────────────────────────────────────────────────────────────────

// const app = express();

// app.use(
//   cors({
//     origin: ALLOWED_ORIGINS.includes("*")
//       ? "*"
//       : (origin, cb) => {
//           if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
//           else cb(new Error(`Origin ${origin} not allowed`));
//         },
//     methods: ["GET", "POST", "DELETE", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//   })
// );

// app.use(express.json({ limit: "2mb" }));

// app.use(
//   express.static(path.join(__dirname, "public"), {
//     index: false,
//     setHeaders: (res, filePath) => {
//       if (filePath.endsWith(".js") || filePath.endsWith(".css"))
//         res.setHeader("Cache-Control", "public, max-age=300");
//     },
//   })
// );

// // ─────────────────────────────────────────────────────────────────────────────
// // Multer — trade-in photo uploads
// // ─────────────────────────────────────────────────────────────────────────────

// const upload = multer({
//   storage: multer.diskStorage({
//     destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
//     filename: (req, file, cb) => {
//       const sessionId = (req.body && req.body.sessionId) || "unknown-session";
//       const safe = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
//       const ext = path.extname(file.originalname || "").slice(0, 10);
//       cb(null, `${safe}_${Date.now()}_${uuidv4()}${ext}`);
//     },
//   }),
//   limits: { fileSize: 8 * 1024 * 1024, files: 6 },
//   fileFilter: (_req, file, cb) => {
//     const ok = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
//     cb(null, ok.includes(file.mimetype));
//   },
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Multer — knowledge-base document uploads (PDF / TXT)
// // Files land in KB_UPLOAD_DIR, text is extracted, then the file is deleted.
// // ─────────────────────────────────────────────────────────────────────────────

// const kbUpload = multer({
//   storage: multer.diskStorage({
//     destination: (_req, _file, cb) => cb(null, KB_UPLOAD_DIR),
//     filename: (_req, file, cb) => {
//       const ext = path.extname(file.originalname || "").toLowerCase().slice(0, 10);
//       cb(null, `kb_${Date.now()}_${uuidv4()}${ext}`);
//     },
//   }),
//   limits: { fileSize: 20 * 1024 * 1024, files: 1 },
//   fileFilter: (_req, file, cb) => {
//     const okTypes = ["application/pdf", "text/plain", "text/txt"];
//     const okExts = [".pdf", ".txt"];
//     const ext = path.extname(file.originalname || "").toLowerCase();
//     if (okTypes.includes(file.mimetype) || okExts.includes(ext)) cb(null, true);
//     else cb(new Error("Only PDF and TXT files are accepted for the knowledge base."));
//   },
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Text-extraction helpers
// // ─────────────────────────────────────────────────────────────────────────────

// function extractTextFromTxt(filePath) {
//   return fs.readFileSync(filePath, "utf8");
// }

// async function extractTextFromPdf(filePath) {
//   let pdfParse;
//   try {
//     pdfParse = require("pdf-parse");
//   } catch {
//     throw new Error("pdf-parse is not installed. Run: npm install pdf-parse");
//   }
//   const buffer = fs.readFileSync(filePath);
//   const data = await pdfParse(buffer);
//   return data.text || "";
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // Shared helpers
// // ─────────────────────────────────────────────────────────────────────────────

// function validateMessage(msg) {
//   if (!msg || typeof msg !== "string") return false;
//   const t = msg.trim();
//   return t.length >= 1 && t.length <= 5000;
// }

// function validateLanguage(lang) {
//   const allowed = ["English", "Mandarin", "Arabic", "Hindi"];
//   return !lang || allowed.includes(lang) ? lang || "English" : "English";
// }

// function getOrCreateSession(incomingId, language) {
//   let sessionId = incomingId;
//   let session;
//   if (sessionId && sessions.has(sessionId)) {
//     session = sessions.get(sessionId);
//     session.updatedAt = new Date();
//   } else {
//     sessionId = uuidv4();
//     session = {
//       messages: [],
//       language,
//       uploads: [],
//       userTurns: 0,
//       handoverRequested: false,
//       handoverSubmitted: false,
//       leadContact: null,
//       createdAt: new Date(),
//       updatedAt: new Date(),
//     };
//     sessions.set(sessionId, session);
//   }
//   return { sessionId, session };
// }

// function recordUserTurn(session) {
//   session.userTurns = (session.userTurns || 0) + 1;
// }

// /**
//  * Calls OpenAI with the session history.
//  * Fetches the current knowledge base from MongoDB and injects it as a
//  * system message so the AI answers from the stored content.
//  */
// async function getAssistantReply(session, language, { nudgeHandoff = false } = {}) {
//   const llmMessages = [{ role: "system", content: SYSTEM_PROMPT }];

//   // ── Inject knowledge base from MongoDB ──────────────────────────────────
//   const kbBlock = await buildKnowledgeBaseBlock();
//   if (kbBlock) {
//     llmMessages.push({
//       role: "system",
//       content:
//         "## Knowledge Base\n" +
//         "The following information has been provided by the business. " +
//         "Use it as your PRIMARY source of truth for product details, policies, pricing, FAQs, " +
//         "inventory, and any business-specific information. " +
//         "Always prefer these facts over general knowledge.\n\n" +
//         kbBlock,
//     });
//   }

//   if (language && language !== "English") {
//     llmMessages.push({
//       role: "system",
//       content: `The user has selected ${language} as their preferred language. Please respond in ${language} from now on.`,
//     });
//   }

//   if (nudgeHandoff) {
//     llmMessages.push({ role: "system", content: HANDOFF_NUDGE });
//   }

//   for (const msg of session.messages.slice(-30)) {
//     llmMessages.push({ role: msg.role, content: msg.content });
//   }

//   const completion = await openai.chat.completions.create({
//     model: "gpt-4",
//     messages: llmMessages,
//     max_tokens: 700,
//     temperature: 0.6,
//   });

//   return (
//     completion.choices?.[0]?.message?.content ||
//     "Sorry, that didn't come through properly on our end — could you try sending that again?"
//   );
// }

// function escapeHtml(str) {
//   return String(str || "")
//     .replace(/&/g, "&amp;")
//     .replace(/</g, "&lt;")
//     .replace(/>/g, "&gt;");
// }

// function renderTranscriptHtml(messages) {
//   return messages
//     .map((m) => {
//       const who =
//         m.role === "assistant" ? "Buy My Next Car AI" : m.role === "system" ? "Note" : "Customer";
//       const bg =
//         m.role === "assistant" ? "#EFF6FF" : m.role === "system" ? "#F3F4F6" : "#F5F0E8";
//       return `<div style="margin:0 0 10px;padding:10px 14px;background:${bg};border-radius:10px;">
//         <div style="font-size:11px;font-weight:600;color:#2C3338;margin-bottom:4px;">${who}</div>
//         <div style="font-size:13px;color:#2C3338;white-space:pre-wrap;">${escapeHtml(m.content)}</div>
//       </div>`;
//     })
//     .join("");
// }

// async function notifyLeadByEmail(sessionId, session, contact) {
//   if (!LEAD_EMAIL_READY) {
//     console.log(`[Handover] Email not configured — lead for session ${sessionId} stored in-memory.`);
//     return;
//   }

//   const html = `
//     <div style="font-family:Arial,sans-serif;max-width:640px;">
//       <h2 style="color:#2563EB;">New chat lead</h2>
//       <p style="color:#6B7280;">Session ${escapeHtml(sessionId)} · ${escapeHtml(session.language || "English")}</p>
//       <table style="width:100%;border-collapse:collapse;margin:16px 0;">
//         <tr><td style="padding:4px 0;font-weight:600;width:110px;">Name</td><td>${escapeHtml(contact.name)}</td></tr>
//         <tr><td style="padding:4px 0;font-weight:600;">Phone</td><td>${escapeHtml(contact.phone || "—")}</td></tr>
//         <tr><td style="padding:4px 0;font-weight:600;">Email</td><td>${escapeHtml(contact.email || "—")}</td></tr>
//         <tr><td style="padding:4px 0;font-weight:600;vertical-align:top;">Notes</td><td>${escapeHtml(contact.notes || "—")}</td></tr>
//         <tr><td style="padding:4px 0;font-weight:600;">Photos</td><td>${session.uploads.length} attached</td></tr>
//       </table>
//       <h3 style="color:#2C3338;">Conversation</h3>
//       ${renderTranscriptHtml(session.messages)}
//       <p style="color:#9CA3AF;font-size:11px;margin-top:20px;">
//         Indicative guidance only — confirm all pricing, availability, trade value and finance figures directly with the customer.
//       </p>
//     </div>`;

//   const attachments = session.uploads
//     .filter((u) => fs.existsSync(u.path))
//     .map((u, idx) => ({
//       filename: u.originalName || `trade-in-photo-${idx + 1}.jpg`,
//       path: u.path,
//       contentType: u.mimeType,
//     }));

//   try {
//     await mailTransporter.sendMail({
//       from: LEAD_NOTIFY_FROM,
//       to: LEAD_NOTIFY_EMAIL.join(","),
//       subject: `New lead — Buy My Next Car — ${contact.name}`,
//       html,
//       attachments,
//     });
//     console.log(`[Mail] Lead email sent for session ${sessionId}`);
//   } catch (err) {
//     console.error("[Mail] Failed to send lead email:", err?.message || err);
//   }
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // ★ KNOWLEDGE BASE ROUTES  (/api/knowledge)
// // ─────────────────────────────────────────────────────────────────────────────

// /**
//  * POST /api/knowledge
//  *
//  * Add a knowledge-base entry. Three accepted formats:
//  *
//  * 1. PDF upload  (multipart/form-data, field "document", .pdf file)
//  * 2. TXT upload  (multipart/form-data, field "document", .txt file)
//  * 3. Free text   (application/json, body: { "text": "...", "label": "..." })
//  *
//  * Optional field in all modes: "label" — human-readable name for the entry.
//  *
//  * Returns 201:
//  *   { id, label, source, charCount, totalEntries, totalChars, addedAt }
//  *
//  * ── curl examples ──────────────────────────────────────────────────────────
//  *
//  *  PDF:
//  *    curl -X POST http://localhost:4099/api/knowledge \
//  *      -F "document=@./pricing.pdf" -F "label=Pricing Guide"
//  *
//  *  TXT:
//  *    curl -X POST http://localhost:4099/api/knowledge \
//  *      -F "document=@./faq.txt" -F "label=FAQ"
//  *
//  *  Free text:
//  *    curl -X POST http://localhost:4099/api/knowledge \
//  *      -H "Content-Type: application/json" \
//  *      -d '{ "text": "Toyota Camry 2024 from AUD 38,990.", "label": "Pricing" }'
//  */
// app.post(
//   "/api/knowledge",
//   // Only run multer when the request is multipart — skip it for JSON bodies.
//   (req, res, next) => {
//     const ct = req.headers["content-type"] || "";
//     if (ct.includes("multipart/form-data")) kbUpload.single("document")(req, res, next);
//     else next();
//   },
//   async (req, res) => {
//     try {
//       let text = "";
//       let source = "free-text";
//       let label = "";

//       // ── File upload ──────────────────────────────────────────────────────
//       if (req.file) {
//         const filePath = req.file.path;
//         const ext = path.extname(req.file.originalname || "").toLowerCase();
//         label =
//           req.body?.label?.trim().slice(0, 200) ||
//           req.file.originalname ||
//           "Uploaded document";

//         try {
//           if (ext === ".pdf" || req.file.mimetype === "application/pdf") {
//             text = await extractTextFromPdf(filePath);
//             source = "pdf";
//           } else {
//             text = extractTextFromTxt(filePath);
//             source = "txt";
//           }
//         } finally {
//           // Temp file no longer needed — delete immediately.
//           fs.unlink(filePath, () => {});
//         }

//         if (!text?.trim()) {
//           return res.status(422).json({
//             error:
//               "Could not extract any text from the uploaded file. " +
//               "Make sure the PDF is not scanned/image-only and is not password-protected.",
//           });
//         }
//       }

//       // ── Free text (JSON) ─────────────────────────────────────────────────
//       else if (req.body && typeof req.body.text === "string") {
//         text = req.body.text;
//         label =
//           typeof req.body.label === "string"
//             ? req.body.label.trim().slice(0, 200)
//             : "Free text entry";
//         source = "free-text";
//       } else {
//         return res.status(400).json({
//           error:
//             "Provide either a file upload (PDF or TXT) via multipart/form-data with field name 'document', " +
//             "or a JSON body with a 'text' field.",
//         });
//       }

//       // ── Validate ─────────────────────────────────────────────────────────
//       text = text.trim();
//       if (!text) return res.status(400).json({ error: "The provided text is empty." });

//       if (text.length > KB_MAX_CHARS_PER_ENTRY) {
//         text = text.slice(0, KB_MAX_CHARS_PER_ENTRY);
//         console.warn(`[KB] Entry truncated to ${KB_MAX_CHARS_PER_ENTRY} chars.`);
//       }

//       // Check total KB size limit against MongoDB
//       const currentTotal = await kbTotalChars();
//       if (currentTotal + text.length > KB_MAX_TOTAL_CHARS) {
//         return res.status(413).json({
//           error:
//             `Knowledge base is full (${KB_MAX_TOTAL_CHARS.toLocaleString()} char limit). ` +
//             "Delete existing entries first via DELETE /api/knowledge/:id or DELETE /api/knowledge.",
//           currentTotalChars: currentTotal,
//           limitChars: KB_MAX_TOTAL_CHARS,
//         });
//       }

//       if (!label) label = `Entry ${Date.now()}`;

//       // ── Persist to MongoDB ────────────────────────────────────────────────
//       const id = uuidv4();
//       const entry = await KnowledgeEntry.create({
//         id,
//         label,
//         text,
//         source,
//         charCount: text.length,
//       });

//       const totalEntries = await KnowledgeEntry.countDocuments();
//       const totalChars = await kbTotalChars();

//       console.log(
//         `[KB] Added id=${id} label="${label}" source=${source} chars=${text.length} totalEntries=${totalEntries}`
//       );

//       return res.status(201).json({
//         id: entry.id,
//         label: entry.label,
//         source: entry.source,
//         charCount: entry.charCount,
//         totalEntries,
//         totalChars,
//         addedAt: entry.addedAt,
//       });
//     } catch (err) {
//       console.error("[KB] Error adding entry:", err?.message || err);
//       return res.status(500).json({ error: err?.message || "Failed to process the knowledge base entry." });
//     }
//   }
// );

// /**
//  * GET /api/knowledge
//  *
//  * List all knowledge-base entries (metadata only — text is excluded to keep
//  * the response lightweight; use GET /api/knowledge/:id to retrieve full text).
//  *
//  * Returns:
//  *   { totalEntries, totalChars, limitChars, entries: [{ id, label, source, charCount, addedAt }] }
//  */
// app.get("/api/knowledge", async (_req, res) => {
//   try {
//     const entries = await KnowledgeEntry.find({}, "-text -_id -__v").lean();
//     const totalChars = await kbTotalChars();

//     return res.json({
//       totalEntries: entries.length,
//       totalChars,
//       limitChars: KB_MAX_TOTAL_CHARS,
//       entries: entries.map((e) => ({
//         id: e.id,
//         label: e.label,
//         source: e.source,
//         charCount: e.charCount,
//         addedAt: e.addedAt,
//       })),
//     });
//   } catch (err) {
//     console.error("[KB] List error:", err?.message || err);
//     return res.status(500).json({ error: "Failed to list knowledge base entries." });
//   }
// });

// /**
//  * GET /api/knowledge/:id
//  *
//  * Retrieve a single entry including its full text.
//  */
// app.get("/api/knowledge/:id", async (req, res) => {
//   try {
//     const entry = await KnowledgeEntry.findOne({ id: req.params.id }, "-_id -__v").lean();
//     if (!entry) return res.status(404).json({ error: "Knowledge base entry not found." });
//     return res.json(entry);
//   } catch (err) {
//     console.error("[KB] Get error:", err?.message || err);
//     return res.status(500).json({ error: "Failed to retrieve knowledge base entry." });
//   }
// });

// /**
//  * DELETE /api/knowledge/:id
//  *
//  * Delete a single entry by its UUID.
//  */
// app.delete("/api/knowledge/:id", async (req, res) => {
//   try {
//     const result = await KnowledgeEntry.deleteOne({ id: req.params.id });
//     if (result.deletedCount === 0)
//       return res.status(404).json({ error: "Knowledge base entry not found." });

//     const totalEntries = await KnowledgeEntry.countDocuments();
//     const totalChars = await kbTotalChars();
//     console.log(`[KB] Deleted id=${req.params.id}. Remaining: ${totalEntries}`);
//     return res.json({ success: true, totalEntries, totalChars });
//   } catch (err) {
//     console.error("[KB] Delete error:", err?.message || err);
//     return res.status(500).json({ error: "Failed to delete knowledge base entry." });
//   }
// });

// /**
//  * DELETE /api/knowledge
//  *
//  * Wipe the entire knowledge base (all entries).
//  */
// app.delete("/api/knowledge", async (_req, res) => {
//   try {
//     const result = await KnowledgeEntry.deleteMany({});
//     console.log(`[KB] Cleared entire knowledge base (${result.deletedCount} entries removed).`);
//     return res.json({ success: true, deletedEntries: result.deletedCount });
//   } catch (err) {
//     console.error("[KB] Clear error:", err?.message || err);
//     return res.status(500).json({ error: "Failed to clear knowledge base." });
//   }
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Chat Routes
// // ─────────────────────────────────────────────────────────────────────────────

// /**
//  * GET /health
//  */
// app.get("/health", async (_req, res) => {
//   const kbEntries = await KnowledgeEntry.countDocuments().catch(() => -1);
//   const kbChars = await kbTotalChars().catch(() => -1);
//   res.json({
//     ok: true,
//     activeSessions: sessions.size,
//     knowledgeBaseEntries: kbEntries,
//     knowledgeBaseChars: kbChars,
//     mongoState: mongoose.connection.readyState, // 1 = connected
//     timestamp: new Date().toISOString(),
//   });
// });

// /**
//  * POST /api/chat/message
//  * Body: { sessionId?: string, message: string, language?: string }
//  * Returns: { sessionId, message, conversationLength, handoffRequired, handoffSubmitted }
//  */
// app.post("/api/chat/message", async (req, res) => {
//   const { sessionId: incomingSessionId, message, language: rawLanguage } = req.body;

//   if (!validateMessage(message)) {
//     return res.status(400).json({
//       error: "Invalid message. Must be a non-empty string up to 5000 characters.",
//     });
//   }

//   const language = validateLanguage(rawLanguage);
//   const { sessionId, session } = getOrCreateSession(incomingSessionId, language);

//   session.messages.push({ role: "user", content: message });
//   recordUserTurn(session);

//   const shouldNudgeHandoff =
//     !session.handoverRequested && session.userTurns >= MAX_USER_TURNS_BEFORE_HANDOFF;

//   let assistantContent;
//   try {
//     assistantContent = await getAssistantReply(session, language, {
//       nudgeHandoff: shouldNudgeHandoff,
//     });
//   } catch (err) {
//     console.error("[OpenAI] API error:", err?.message || err);
//     const status = err?.status;
//     if (status === 429)
//       return res.status(429).json({
//         error: "Our system's a little busy right now — please try again in a moment.",
//       });
//     if (status === 401)
//       return res.status(500).json({
//         error: "We're having a technical issue on our end. Please try again shortly.",
//       });
//     return res.status(500).json({
//       error: "We're having trouble connecting right now. Please try again in a moment.",
//     });
//   }

//   if (shouldNudgeHandoff) {
//     session.handoverRequested = true;
//     console.log(
//       `[Handoff] sessionId=${sessionId} reached ${session.userTurns} turns — nudged toward handover.`
//     );
//   }

//   session.messages.push({ role: "assistant", content: assistantContent });
//   console.log(`[Chat] sessionId=${sessionId} lang=${language} msgCount=${session.messages.length}`);

//   return res.json({
//     sessionId,
//     message: assistantContent,
//     conversationLength: session.messages.length,
//     handoffRequired: session.handoverRequested,
//     handoffSubmitted: session.handoverSubmitted,
//   });
// });

// /**
//  * POST /api/chat/upload
//  * multipart/form-data: sessionId (text field), photos (one or more image files)
//  */
// app.post("/api/chat/upload", upload.array("photos", 6), (req, res) => {
//   const incomingSessionId = req.body && req.body.sessionId;
//   const language = validateLanguage(req.body && req.body.language);

//   if (!req.files || req.files.length === 0)
//     return res.status(400).json({ error: "No photos were received." });

//   const { sessionId, session } = getOrCreateSession(incomingSessionId, language);

//   const uploadRecords = req.files.map((f) => ({
//     filename: f.filename,
//     originalName: f.originalname,
//     mimeType: f.mimetype,
//     path: f.path,
//     uploadedAt: new Date(),
//   }));
//   session.uploads.push(...uploadRecords);
//   session.updatedAt = new Date();

//   session.messages.push({
//     role: "system",
//     content:
//       `[System note: the customer just uploaded ${req.files.length} photo(s) for their trade valuation/assessment. ` +
//       `Total photos so far: ${session.uploads.length}. Acknowledge receipt warmly and let them know a Buy My Next Car ` +
//       `specialist will review the photos. Do not claim to have analysed the images yourself.]`,
//   });

//   console.log(`[Upload] sessionId=${sessionId} files=${uploadRecords.length} totalUploads=${session.uploads.length}`);
//   return res.json({ sessionId, uploaded: req.files.length, message: "Photos received." });
// });

// /**
//  * POST /api/chat/handover
//  * Body: { sessionId, name, phone?, email?, notes? }
//  */
// app.post("/api/chat/handover", async (req, res) => {
//   const { sessionId, name, phone, email, notes } = req.body;

//   if (!sessionId || typeof sessionId !== "string" || !sessions.has(sessionId))
//     return res.status(400).json({
//       error: "We couldn't find that conversation — please send a message in the chat first.",
//     });
//   if (!name || typeof name !== "string" || !name.trim())
//     return res.status(400).json({ error: "Please include your name." });

//   const hasPhone = typeof phone === "string" && phone.trim().length > 0;
//   const hasEmail = typeof email === "string" && email.trim().length > 0;
//   if (!hasPhone && !hasEmail)
//     return res.status(400).json({
//       error: "Please include a phone number or email so our team can reach you.",
//     });

//   const session = sessions.get(sessionId);
//   const contact = {
//     name: name.trim().slice(0, 200),
//     phone: hasPhone ? phone.trim().slice(0, 50) : "",
//     email: hasEmail ? email.trim().slice(0, 200) : "",
//     notes: typeof notes === "string" ? notes.trim().slice(0, 1000) : "",
//     submittedAt: new Date(),
//   };

//   session.leadContact = contact;
//   session.handoverSubmitted = true;
//   session.handoverRequested = true;
//   session.updatedAt = new Date();

//   session.messages.push({
//     role: "user",
//     content:
//       `[Customer submitted their details for specialist follow-up — name: ${contact.name}, ` +
//       `phone: ${contact.phone || "—"}, email: ${contact.email || "—"}` +
//       (contact.notes ? `, notes: "${contact.notes}"` : "") + `]`,
//   });

//   await notifyLeadByEmail(sessionId, session, contact);

//   console.log(
//     `[Handover] sessionId=${sessionId} name=${contact.name} photos=${session.uploads.length} email=${
//       LEAD_EMAIL_READY ? "sent" : "not configured"
//     }`
//   );

//   return res.json({
//     success: true,
//     message:
//       "Thanks — that's with our team now. A specialist will be in touch with verified pricing, availability or finance details shortly.",
//   });
// });

// /**
//  * POST /api/chat/reset
//  * Body: { sessionId }
//  */
// app.post("/api/chat/reset", (req, res) => {
//   const { sessionId } = req.body;
//   if (!sessionId || typeof sessionId !== "string")
//     return res.status(400).json({ error: "sessionId is required." });

//   if (sessions.has(sessionId)) {
//     const session = sessions.get(sessionId);
//     for (const u of session.uploads)
//       fs.unlink(u.path, (err) => {
//         if (err) console.warn(`[Reset] Could not remove upload ${u.path}:`, err.message);
//       });
//     session.messages = [];
//     session.uploads = [];
//     session.userTurns = 0;
//     session.handoverRequested = false;
//     session.handoverSubmitted = false;
//     session.leadContact = null;
//     session.updatedAt = new Date();
//     console.log(`[Chat] Session reset: ${sessionId}`);
//   }

//   return res.json({ success: true });
// });

// /**
//  * GET /api/chat/session/:sessionId
//  */
// app.get("/api/chat/session/:sessionId", (req, res) => {
//   const session = sessions.get(req.params.sessionId);
//   if (!session) return res.status(404).json({ error: "Session not found." });

//   return res.json({
//     sessionId: req.params.sessionId,
//     messages: session.messages,
//     language: session.language,
//     uploads: session.uploads.map(({ filename, originalName, mimeType, uploadedAt }) => ({
//       filename,
//       originalName,
//       mimeType,
//       uploadedAt,
//     })),
//     handoffRequired: session.handoverRequested,
//     handoffSubmitted: session.handoverSubmitted,
//     createdAt: session.createdAt,
//     updatedAt: session.updatedAt,
//   });
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Error handler
// // ─────────────────────────────────────────────────────────────────────────────

// app.use((err, _req, res, _next) => {
//   console.error("[Server Error]", err);
//   if (err?.message?.includes("not allowed"))
//     return res.status(403).json({ error: "Origin not allowed." });
//   if (err?.message?.includes("Only PDF"))
//     return res.status(415).json({ error: err.message });
//   res.status(500).json({ error: "Internal server error." });
// });

// // ─────────────────────────────────────────────────────────────────────────────
// // Boot — connect to MongoDB first, then start HTTP server
// // ─────────────────────────────────────────────────────────────────────────────

// async function start() {
//   console.log("\n🔌 Connecting to MongoDB…");
//   await mongoose.connect(MONGODB_URI, {
//     serverSelectionTimeoutMS: 10_000,
//     socketTimeoutMS: 45_000,
//   });
//   // Connection event above will log the host.

//   app.listen(PORT, () => {
//     console.log(`\n🚗 Buy My Next Car — Chatbot Backend`);
//     console.log(`   Local:  http://localhost:${PORT}`);
//     console.log(`   Public: https://buycarbot.omnisuiteai.com`);
//     console.log(`   Model: gpt-4`);
//     console.log(`   Uploads dir (private): ${UPLOAD_DIR}`);
//     console.log(`   Market: Australia only`);
//     console.log(`   Entity: ${COMPANY.legalName} — ABN ${COMPANY.abn} / ACN ${COMPANY.acn}`);
//     console.log(`   Handoff threshold: ${MAX_USER_TURNS_BEFORE_HANDOFF} customer turns`);
//     console.log(
//       `   Lead emails: ${
//         LEAD_EMAIL_READY ? `${LEAD_NOTIFY_FROM} → ${LEAD_NOTIFY_EMAIL.join(", ")}` : "not configured"
//       }`
//     );
//     console.log(`   Sessions: in-memory`);
//     console.log(`   Knowledge Base: MongoDB (collection: knowledgeentries)`);
//     console.log(`\n   ★ Knowledge Base API:`);
//     console.log(`     POST   /api/knowledge        — add entry (PDF, TXT, or free text)`);
//     console.log(`     GET    /api/knowledge        — list all entries`);
//     console.log(`     GET    /api/knowledge/:id    — get single entry (with full text)`);
//     console.log(`     DELETE /api/knowledge/:id    — delete single entry`);
//     console.log(`     DELETE /api/knowledge        — wipe entire KB\n`);
//   });
// }

// start().catch((err) => {
//   console.error("[FATAL] Failed to start:", err?.message || err);
//   process.exit(1);
// });
require("dotenv").config();

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
const KB_MAX_TOTAL_CHARS     = 400_000; // cumulative across all entries

const COMPANY = {
  legalName:              "Test Drive Group Pty Ltd",
  tradingAs:              "Buy My Next Car",
  abn:                    "51 679 064 343",
  acn:                    "679 064 343",
  companyType:            "Australian Proprietary Company, Limited By Shares",
  registrationDate:       "12/07/2024",
  status:                 "Registered",
  registeredOfficeLocality: "Rowville VIC 3178",
  regulator:              "Australian Securities & Investments Commission (ASIC)",
  phone:                  "0440 130 476",
  email:                  "contact@buymynextcar.com.au",
};

const FINANCE_PARTNER = {
  legalName:   "Acquired Financial Services Pty Ltd",
  tradingAs:   "Acquired Finance",
  acl:         "488607",           // Australian Credit Licence
  phone:       "1300 235 255",
  website:     "www.acquiredfinance.com",
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
const SMTP_HOST     = process.env.SMTP_HOST || "";
const SMTP_PORT     = parseInt(process.env.SMTP_PORT || "465", 10);
const SMTP_SECURE   = String(process.env.SMTP_SECURE).toLowerCase() === "true";
const SMTP_USER     = process.env.SMTP_USER || "";
const SMTP_PASS     = process.env.SMTP_PASS || "";
const LEAD_NOTIFY_FROM  = process.env.LEAD_NOTIFY_FROM || SMTP_USER;
const LEAD_NOTIFY_EMAIL = (process.env.LEAD_NOTIFY_EMAIL || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

const SMTP_CONFIGURED  = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
const LEAD_EMAIL_READY = SMTP_CONFIGURED && LEAD_NOTIFY_EMAIL.length > 0;

let mailTransporter = null;
if (SMTP_CONFIGURED) {
  mailTransporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   SMTP_PORT,
    secure: SMTP_SECURE,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  });
  mailTransporter.verify().then(
    ()    => console.log("[Mail] SMTP verified — lead emails will send."),
    (err) => console.error("[Mail] SMTP verification failed:", err?.message || err)
  );
} else {
  console.warn("[Mail] SMTP not configured — lead emails will NOT send.");
}

// ─────────────────────────────────────────────────────────────────────────────
// MongoDB connection
// ─────────────────────────────────────────────────────────────────────────────

mongoose.set("strictQuery", true);

mongoose.connection.on("connected",    () => console.log("[MongoDB] Connected to:", mongoose.connection.host));
mongoose.connection.on("error",        (err) => console.error("[MongoDB] Connection error:", err.message));
mongoose.connection.on("disconnected", () => console.warn("[MongoDB] Disconnected — will auto-reconnect."));

// ─────────────────────────────────────────────────────────────────────────────
// KnowledgeEntry Mongoose model
// ─────────────────────────────────────────────────────────────────────────────

const knowledgeEntrySchema = new mongoose.Schema(
  {
    id:        { type: String, required: true, unique: true, index: true },
    label:     { type: String, required: true, maxlength: 200 },
    text:      { type: String, required: true },
    source:    { type: String, enum: ["pdf", "txt", "free-text"], default: "free-text" },
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
- Consultative, not reactive: every reply should move the conversation forward — toward an enquiry, a finance referral, a trade valuation, or a purchase.

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
1. **Vehicle Consultant** — Understand what the customer needs before recommending anything.
2. **Finance Referral Concierge** — Walk customers through a natural, conversational finance referral (NOT credit assessment — see Finance Referral section below).
3. **Trade Valuation Concierge** — Collect details needed for a specialist to prepare an estimated trade value.
4. **Multi-language** — Converse in English, Mandarin (中文), Arabic (العربية), Hindi (हिन्दी), and others as needed.

---

## Collecting Contact Details
Before wrapping up any conversation, collect the customer's name and at least one contact method (phone or email).

---

## VEHICLE CONVERSATION — natural, one/two questions at a time
Guide them through: new or used? → vehicle type/brand/model? → intended use (personal, business, fleet)? → budget? → features/lifestyle needs? → location/delivery? → timing?

---

## FINANCE REFERRAL — Rules (critical, non-negotiable)

**What Buy My Next Car is:** A finance referrer only. We do NOT provide credit assistance, assess creditworthiness, recommend a particular lender or credit product, or approve finance.

**Our broker partner:** Acquired Financial Services Pty Ltd (Australian Credit Licence **${FINANCE_PARTNER.acl}**), trading as Acquired Finance.
- Phone: ${FINANCE_PARTNER.phone}
- Website: ${FINANCE_PARTNER.website}
- Lender panel: ${FINANCE_PARTNER.lenderPanel} bank and non-bank lenders

### What you MAY say about finance
- "Our broker partner can compare options across a panel of ${FINANCE_PARTNER.lenderPanel}+ bank and non-bank lenders."
- "Their broker will discuss available rates and repayments based on your circumstances."
- "Would you like me to arrange a call? I only need your name, phone number and the vehicle you're considering."
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

### Finance referral workflow
When a customer expresses interest in finance, explain the referral briefly, then:
1. Mention that Test Drive Group may receive a commission or referral benefit if they proceed.
2. Obtain explicit consent using this wording (display it clearly):

> **"Yes, refer me to Acquired Financial Services. I consent to Test Drive Group Pty Ltd, operator of Buy My Next Car, providing my name, telephone number and brief vehicle or finance enquiry details to Acquired Financial Services Pty Ltd so that a licensed finance broker can contact me. I understand that Test Drive Group Pty Ltd may receive a commission or referral benefit if I proceed with finance arranged by Acquired Financial Services."**

3. Only after the customer confirms — collect: **name, phone number, and a brief description of the vehicle or finance purpose**. Nothing else.
4. Let them know a specialist will be in touch within 5 business days.

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

app.use(
  express.static(path.join(__dirname, "public"), {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".js") || filePath.endsWith(".css"))
        res.setHeader("Cache-Control", "public, max-age=300");
    },
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Multer — trade-in photo uploads
// ─────────────────────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const sessionId = (req.body && req.body.sessionId) || "unknown-session";
      const safe = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
      const ext  = path.extname(file.originalname || "").slice(0, 10);
      cb(null, `${safe}_${Date.now()}_${uuidv4()}${ext}`);
    },
  }),
  limits:     { fileSize: 8 * 1024 * 1024, files: 6 },
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
  limits:     { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const okTypes = ["application/pdf", "text/plain", "text/txt"];
    const okExts  = [".pdf", ".txt"];
    const ext     = path.extname(file.originalname || "").toLowerCase();
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
  const data   = await pdfParse(buffer);
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
    sessionId = uuidv4();
    session = {
      messages:           [],
      language,
      uploads:            [],
      userTurns:          0,
      handoverRequested:  false,
      handoverSubmitted:  false,
      leadContact:        null,
      createdAt:          new Date(),
      updatedAt:          new Date(),
    };
    sessions.set(sessionId, session);
  }
  return { sessionId, session };
}

function recordUserTurn(session) {
  session.userTurns = (session.userTurns || 0) + 1;
}

/**
 * Calls OpenAI with the session history.
 * Fetches the current knowledge base from MongoDB and injects it as a
 * system message so the AI answers from stored content first.
 */
async function getAssistantReply(session, language, { nudgeHandoff = false } = {}) {
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

  if (nudgeHandoff) {
    llmMessages.push({ role: "system", content: HANDOFF_NUDGE });
  }

  for (const msg of session.messages.slice(-30)) {
    llmMessages.push({ role: msg.role, content: msg.content });
  }

  const completion = await openai.chat.completions.create({
    model:       "gpt-4",
    messages:    llmMessages,
    max_tokens:  700,
    temperature: 0.6,
  });

  return (
    completion.choices?.[0]?.message?.content ||
    "Sorry, that didn't come through properly on our end — could you try sending that again?"
  );
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;");
}

function renderTranscriptHtml(messages) {
  return messages
    .map((m) => {
      const who =
        m.role === "assistant" ? "Buy My Next Car AI" : m.role === "system" ? "Note" : "Customer";
      const bg =
        m.role === "assistant" ? "#EFF6FF" : m.role === "system" ? "#F3F4F6" : "#F5F0E8";
      return `<div style="margin:0 0 10px;padding:10px 14px;background:${bg};border-radius:10px;">
        <div style="font-size:11px;font-weight:600;color:#2C3338;margin-bottom:4px;">${who}</div>
        <div style="font-size:13px;color:#2C3338;white-space:pre-wrap;">${escapeHtml(m.content)}</div>
      </div>`;
    })
    .join("");
}

async function notifyLeadByEmail(sessionId, session, contact) {
  if (!LEAD_EMAIL_READY) {
    console.log(`[Handover] Email not configured — lead for session ${sessionId} stored in-memory.`);
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;">
      <h2 style="color:#2563EB;">New chat lead</h2>
      <p style="color:#6B7280;">Session ${escapeHtml(sessionId)} · ${escapeHtml(session.language || "English")}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:4px 0;font-weight:600;width:110px;">Name</td><td>${escapeHtml(contact.name)}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;">Phone</td><td>${escapeHtml(contact.phone || "—")}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;">Email</td><td>${escapeHtml(contact.email || "—")}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;vertical-align:top;">Notes</td><td>${escapeHtml(contact.notes || "—")}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;">Photos</td><td>${session.uploads.length} attached</td></tr>
      </table>
      <h3 style="color:#2C3338;">Conversation</h3>
      ${renderTranscriptHtml(session.messages)}
      <p style="color:#9CA3AF;font-size:11px;margin-top:20px;">
        Indicative guidance only — confirm all pricing, availability, trade value and finance figures directly with the customer.
      </p>
    </div>`;

  const attachments = session.uploads
    .filter((u) => fs.existsSync(u.path))
    .map((u, idx) => ({
      filename:    u.originalName || `trade-in-photo-${idx + 1}.jpg`,
      path:        u.path,
      contentType: u.mimeType,
    }));

  try {
    await mailTransporter.sendMail({
      from:        LEAD_NOTIFY_FROM,
      to:          LEAD_NOTIFY_EMAIL.join(","),
      subject:     `New lead — Buy My Next Car — ${contact.name}`,
      html,
      attachments,
    });
    console.log(`[Mail] Lead email sent for session ${sessionId}`);
  } catch (err) {
    console.error("[Mail] Failed to send lead email:", err?.message || err);
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
      let text   = "";
      let source = "free-text";
      let label  = "";

      // ── File upload ──────────────────────────────────────────────────────
      if (req.file) {
        const filePath = req.file.path;
        const ext      = path.extname(req.file.originalname || "").toLowerCase();
        label =
          req.body?.label?.trim().slice(0, 200) ||
          req.file.originalname ||
          "Uploaded document";

        try {
          if (ext === ".pdf" || req.file.mimetype === "application/pdf") {
            text   = await extractTextFromPdf(filePath);
            source = "pdf";
          } else {
            text   = extractTextFromTxt(filePath);
            source = "txt";
          }
        } finally {
          fs.unlink(filePath, () => {});
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
        text  = req.body.text;
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
          limitChars:        KB_MAX_TOTAL_CHARS,
        });
      }

      if (!label) label = `Entry ${Date.now()}`;

      // ── Persist to MongoDB ────────────────────────────────────────────────
      const id    = uuidv4();
      const entry = await KnowledgeEntry.create({
        id,
        label,
        text,
        source,
        charCount: text.length,
      });

      const totalEntries = await KnowledgeEntry.countDocuments();
      const totalChars   = await kbTotalChars();

      console.log(
        `[KB] Added id=${id} label="${label}" source=${source} chars=${text.length} totalEntries=${totalEntries}`
      );

      return res.status(201).json({
        id:           entry.id,
        label:        entry.label,
        source:       entry.source,
        charCount:    entry.charCount,
        totalEntries,
        totalChars,
        addedAt:      entry.addedAt,
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
    const entries    = await KnowledgeEntry.find({}, "-text -_id -__v").lean();
    const totalChars = await kbTotalChars();

    return res.json({
      totalEntries: entries.length,
      totalChars,
      limitChars: KB_MAX_TOTAL_CHARS,
      entries: entries.map((e) => ({
        id:        e.id,
        label:     e.label,
        source:    e.source,
        charCount: e.charCount,
        addedAt:   e.addedAt,
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
    const totalChars   = await kbTotalChars();
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
  const kbChars   = await kbTotalChars().catch(() => -1);
  res.json({
    ok:                    true,
    activeSessions:        sessions.size,
    knowledgeBaseEntries:  kbEntries,
    knowledgeBaseChars:    kbChars,
    mongoState:            mongoose.connection.readyState, // 1 = connected
    timestamp:             new Date().toISOString(),
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

  const language              = validateLanguage(rawLanguage);
  const { sessionId, session } = getOrCreateSession(incomingSessionId, language);

  session.messages.push({ role: "user", content: message });
  recordUserTurn(session);

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

  session.messages.push({ role: "assistant", content: assistantContent });
  console.log(`[Chat] sessionId=${sessionId} lang=${language} msgCount=${session.messages.length}`);

  return res.json({
    sessionId,
    message:            assistantContent,
    conversationLength: session.messages.length,
    handoffRequired:    session.handoverRequested,
    handoffSubmitted:   session.handoverSubmitted,
  });
});

/**
 * POST /api/chat/upload
 * multipart/form-data: sessionId (text field), photos (one or more image files)
 */
app.post("/api/chat/upload", upload.array("photos", 6), (req, res) => {
  const incomingSessionId = req.body && req.body.sessionId;
  const language          = validateLanguage(req.body && req.body.language);

  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: "No photos were received." });

  const { sessionId, session } = getOrCreateSession(incomingSessionId, language);

  const uploadRecords = req.files.map((f) => ({
    filename:     f.filename,
    originalName: f.originalname,
    mimeType:     f.mimetype,
    path:         f.path,
    uploadedAt:   new Date(),
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
    name:        name.trim().slice(0, 200),
    phone:       hasPhone ? phone.trim().slice(0, 50) : "",
    email:       hasEmail ? email.trim().slice(0, 200) : "",
    notes:       typeof notes === "string" ? notes.trim().slice(0, 1000) : "",
    submittedAt: new Date(),
  };

  session.leadContact       = contact;
  session.handoverSubmitted = true;
  session.handoverRequested = true;
  session.updatedAt         = new Date();

  session.messages.push({
    role: "user",
    content:
      `[Customer submitted their details for specialist follow-up — name: ${contact.name}, ` +
      `phone: ${contact.phone || "—"}, email: ${contact.email || "—"}` +
      (contact.notes ? `, notes: "${contact.notes}"` : "") + `]`,
  });

  await notifyLeadByEmail(sessionId, session, contact);

  console.log(
    `[Handover] sessionId=${sessionId} name=${contact.name} photos=${session.uploads.length} email=${
      LEAD_EMAIL_READY ? "sent" : "not configured"
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
    session.messages          = [];
    session.uploads           = [];
    session.userTurns         = 0;
    session.handoverRequested = false;
    session.handoverSubmitted = false;
    session.leadContact       = null;
    session.updatedAt         = new Date();
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
    sessionId:        req.params.sessionId,
    messages:         session.messages,
    language:         session.language,
    uploads:          session.uploads.map(({ filename, originalName, mimeType, uploadedAt }) => ({
      filename,
      originalName,
      mimeType,
      uploadedAt,
    })),
    handoffRequired:  session.handoverRequested,
    handoffSubmitted: session.handoverSubmitted,
    createdAt:        session.createdAt,
    updatedAt:        session.updatedAt,
  });
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
    socketTimeoutMS:          45_000,
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
      `   Lead emails: ${
        LEAD_EMAIL_READY ? `${LEAD_NOTIFY_FROM} → ${LEAD_NOTIFY_EMAIL.join(", ")}` : "not configured"
      }`
    );
    console.log(`   Sessions: in-memory`);
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