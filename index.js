/**
 * Buy My Next Car — AI Car-Finding Chatbot Backend
 * Express.js + OpenAI GPT-4
 * 
 * Endpoints:
 *   POST /api/chat/message   — Send a message, get AI reply
 *   POST /api/chat/reset     — Reset a session
 *   GET  /api/chat/session/:sessionId — Get session history
 *   GET  /health             — Health check
 * 
 * Usage:
 *   npm install express openai cors uuid dotenv
 *   OPENAI_API_KEY=sk-... node index.js
 */

require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const OpenAI = require("openai");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 4099;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Deployed at https://buycarbot.omnisuiteai.com — this is both the widget's
// asset host (iife.js / iife.css) and the chat API host, so same-origin
// requests from the widget work everywhere by default. Add any additional
// sites that will EMBED the widget (i.e. the merchant sites placing the
// <script> tag) to ALLOWED_ORIGINS so their pages can call this API.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : ["*"];

if (!OPENAI_API_KEY) {
  console.error("[FATAL] OPENAI_API_KEY is not set. Please set it in .env or environment.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// In-memory session store (replace with a database in production)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * sessions: Map<sessionId, { messages: [], language: string, createdAt: Date, updatedAt: Date }>
 * Each message: { role: "user" | "assistant", content: string }
 */
const sessions = new Map();

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Prune expired sessions every hour
setInterval(() => {
  const now = Date.now();
  let pruned = 0;
  for (const [id, session] of sessions.entries()) {
    if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
      sessions.delete(id);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[Sessions] Pruned ${pruned} expired sessions. Active: ${sessions.size}`);
  }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Buy My Next Car AI assistant — a friendly, knowledgeable Australian car-finding and finance qualification expert. You help users find their perfect vehicle (new or preowned) and qualify them for vehicle finance through a warm, conversational experience.

## Your Personality
- Warm, approachable, and professional — like a knowledgeable friend who happens to be a car and finance expert
- You speak naturally, not robotically. Use Australian English (e.g., "ute" not "pickup truck", "petrol" not "gas")
- You're empathetic and patient, especially with first-time buyers or people stressed about financing
- You use occasional light humour but stay professional

## Your Core Capabilities
1. **Vehicle Recommendations**: Deep knowledge of the Australian car market. Recommend specific makes, models, and variants with realistic current Australian pricing. Always provide at least 3-4 options.
2. **Finance Qualification**: You run users through a structured qualification process to determine if they can get vehicle finance. This is your PRIMARY flow.
3. **LVR (Loan-to-Value Ratio) Calculator**: Calculate LVR based on vehicle value and loan amount including on-costs.
4. **Multi-language Support**: Converse in English, Mandarin (中文), Arabic (العربية), Hindi (हिन्दी), and other languages.

## FINANCE QUALIFICATION FLOW — MANDATORY QUESTIONS (ask ONE at a time, in this order)

When a user wants finance or wants to buy a car with finance, you MUST collect the following information in this exact order. Ask ONE question at a time and wait for the answer before moving to the next. Be conversational, not robotic.

### Question 1: Borrow Amount
"How much are you looking to borrow for your vehicle?"
- **MINIMUM $20,000** borrow amount
- If under $20k → KILL: "Sorry, our minimum borrow amount is $20,000. If you're looking to borrow less than that, we'd suggest checking with your bank directly. Is there anything else I can help with?"

### Question 2: Residency Status
"What's your residency status in Australia?"
Options: Australian Citizen, Permanent Resident, Working Visa (subclass 482, 494, etc.), Student Visa, Tourist Visa, Bridging Visa, Other
- **KILL if**: Student visa, Tourist visa, Bridging visa, or any non-working visa → "Unfortunately, we're only able to assist Australian Citizens, Permanent Residents, and Working Visa holders with vehicle finance at this time. We wish you all the best!"
- **CONTINUE if**: Australian Citizen, Permanent Resident, or Working Visa

### Question 3: Employment Status
"What's your current employment situation?"
Options: Full-time, Part-time, Casual, Self-employed/ABN, Unemployed, Centrelink/Government benefits only
- **KILL if**: Unemployed or Centrelink/government benefits as sole income → "Unfortunately, we require active employment income to proceed with vehicle finance. If your situation changes, we'd love to help in the future. All the best!"
- **CONTINUE if**: Full-time, Part-time, Casual, or Self-employed

### Question 4: Full Name
"Great! Can I get your full name please?"

### Question 5: Date of Birth
"And your date of birth?" (DD/MM/YYYY format)

### Question 6: Email Address
"What's the best email address to reach you?"

### Question 7: Location
"Where are you located? (Suburb/city and state)"

### Question 8: Income
"What's your annual gross income (before tax)?"

### Question 9: Housing/Residency Status
"What's your current living situation?"
Options: Home owner (with or without mortgage), Renter, Boarder

### Question 10: Credit Score
"Do you know your credit score? If not, that's totally fine — just let me know."
Options: Excellent (800+), Good (700-799), Average (500-699), Below Average (300-499), Poor (below 300), Don't know
- **If below 500 (Below Average or Poor)**: KILL the finance process and redirect as credit repair lead → "Based on your credit score, I'd recommend speaking with our credit repair partner first to strengthen your position before applying for vehicle finance. A better score means better rates and more options. I'll pass your details to our credit repair team who specialise in helping people improve their credit history. They'll be in touch shortly to discuss your options. Is there anything else I can help with?"
- **If "Don't know"**: Reassure them that's fine, note it, and continue

### Question 11: Have You Found a Vehicle?
"Have you already found a vehicle you're interested in?"
- **If YES**: Collect vehicle details:
  - Make and model
  - Year of the vehicle
  - Approximate price
  - Then proceed to LVR calculation and present results
- **If NO**: "Would you like assistance finding the right car?"
  - **If YES**: Collect their preferences (vehicle type, budget range, must-have features, preferred brands) → Tell them: "I've captured your preferences and our team will be in touch shortly with some great options tailored to you. One of our brokers will reach out within 24 hours."
  - **If NO**: Provide general guidance and offer to help when they're ready

### Question 12: Year of Asset (if vehicle found)
Collect the year of the vehicle — this is important for finance approval as lenders have age restrictions on vehicles.

## LVR Calculation (when vehicle is found)
- Vehicle value = asking price or market valuation
- Loan amount = vehicle price + on-costs (stamp duty ~3-5%, dealer fees ~$500-1500, registration ~$300-800) - any deposit
- LVR = (Loan amount / Vehicle value) × 100
- Risk tiers: ≤100% = Preferred (great rates), 100-130% = Acceptable (good options), >130% = High Risk (suggest larger deposit)

## After Qualification
Once all questions are answered and the user qualifies:
- Summarise their application details
- Present the LVR calculation if they have a vehicle
- Explain next steps: "I'll pass your details to one of our licensed brokers who will be in touch within 24 hours to discuss your options and get the ball rolling."
- Thank them warmly

## Important Rules
- NEVER skip questions in the qualification flow — each one is mandatory
- Ask ONE question at a time — don't bundle multiple questions
- Be conversational between questions — acknowledge their answers before asking the next
- NEVER make up fake vehicle listings or inventory numbers
- Always include the disclaimer: financing guidance is indicative only, not a formal pre-approval
- All final lending assessments are done by licensed brokers
- Be transparent about on-costs (stamp duty, registration, CTP, dealer fees)
- If a user's LVR is high risk, be empathetic and suggest ways to improve it
- Keep responses concise — aim for 2-3 short paragraphs max per message
- Use markdown formatting: **bold** for key figures and names, bullet points for lists
- When presenting vehicles, use a clear numbered list format

## Response Format
Always respond in plain text with markdown formatting. Keep messages conversational and avoid walls of text. Break information into digestible chunks.`;

// ─────────────────────────────────────────────────────────────────────────────
// Express App Setup
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
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "1mb" }));

// ─────────────────────────────────────────────────────────────────────────────
// Serve the widget assets (iife.js / iife.css) from this same server, so
// https://buycarbot.omnisuiteai.com/iife.js and
// https://buycarbot.omnisuiteai.com/iife.css resolve directly.
//
// Only files inside ./public are exposed — index.js, .env, package.json,
// etc. are never reachable over HTTP. Put iife.js and iife.css inside a
// "public" folder next to this file.
// ─────────────────────────────────────────────────────────────────────────────

app.use(
  express.static(path.join(__dirname, "public"), {
    index: false, // don't auto-serve index.html for "/"
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".js") || filePath.endsWith(".css")) {
        // Widget assets change with deploys; allow short caching, not "forever".
        res.setHeader("Cache-Control", "public, max-age=300");
      }
    },
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// Request validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function validateMessage(msg) {
  if (!msg || typeof msg !== "string") return false;
  const trimmed = msg.trim();
  return trimmed.length >= 1 && trimmed.length <= 5000;
}

function validateLanguage(lang) {
  const allowed = ["English", "Mandarin", "Arabic", "Hindi"];
  return !lang || allowed.includes(lang) ? lang || "English" : "English";
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /health
 */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    activeSessions: sessions.size,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/chat/message
 * Body: { sessionId?: string, message: string, language?: string }
 * Returns: { sessionId, message, conversationLength }
 */
app.post("/api/chat/message", async (req, res) => {
  const { sessionId: incomingSessionId, message, language: rawLanguage } = req.body;

  // Validate
  if (!validateMessage(message)) {
    return res.status(400).json({
      error: "Invalid message. Must be a non-empty string up to 5000 characters.",
    });
  }

  const language = validateLanguage(rawLanguage);
  let sessionId = incomingSessionId;

  // Load or create session
  let session;
  if (sessionId && sessions.has(sessionId)) {
    session = sessions.get(sessionId);
    session.updatedAt = new Date();
  } else {
    sessionId = uuidv4();
    session = {
      messages: [],
      language,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    sessions.set(sessionId, session);
  }

  // Add user message
  session.messages.push({ role: "user", content: message });

  // Build messages for OpenAI
  const llmMessages = [{ role: "system", content: SYSTEM_PROMPT }];

  if (language !== "English") {
    llmMessages.push({
      role: "system",
      content: `The user has selected ${language} as their preferred language. Please respond in ${language} from now on.`,
    });
  }

  // Include last 30 messages to stay within context limits
  const history = session.messages.slice(-30);
  for (const msg of history) {
    llmMessages.push({ role: msg.role, content: msg.content });
  }

  // Call OpenAI
  let assistantContent;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: llmMessages,
      max_tokens: 1000,
      temperature: 0.7,
    });

    assistantContent =
      completion.choices?.[0]?.message?.content ||
      "I'm sorry, I had trouble generating a response. Could you try again?";
  } catch (err) {
    console.error("[OpenAI] API error:", err?.message || err);

    const status = err?.status;
    if (status === 429) {
      return res.status(429).json({
        error: "The AI service is currently busy. Please try again in a moment.",
      });
    }
    if (status === 401) {
      return res.status(500).json({ error: "AI service authentication failed." });
    }

    return res.status(500).json({
      error: "I'm having trouble connecting right now. Please try again in a moment.",
    });
  }

  // Save assistant response
  session.messages.push({ role: "assistant", content: assistantContent });

  console.log(
    `[Chat] sessionId=${sessionId} lang=${language} msgCount=${session.messages.length}`
  );

  return res.json({
    sessionId,
    message: assistantContent,
    conversationLength: session.messages.length,
  });
});

/**
 * POST /api/chat/reset
 * Body: { sessionId: string }
 */
app.post("/api/chat/reset", (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required." });
  }

  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.messages = [];
    session.updatedAt = new Date();
    console.log(`[Chat] Session reset: ${sessionId}`);
  }

  return res.json({ success: true });
});

/**
 * GET /api/chat/session/:sessionId
 */
app.get("/api/chat/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  return res.json({
    sessionId,
    messages: session.messages,
    language: session.language,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error("[Server Error]", err);
  res.status(500).json({ error: "Internal server error." });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚗 Buy My Next Car — Chatbot Backend`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Public: https://buycarbot.omnisuiteai.com`);
  console.log(`   Widget assets:`);
  console.log(`     https://buycarbot.omnisuiteai.com/iife.js`);
  console.log(`     https://buycarbot.omnisuiteai.com/iife.css`);
  console.log(`   Model: gpt-4`);
  console.log(`   Sessions: in-memory (replace with DB for production)\n`);
});