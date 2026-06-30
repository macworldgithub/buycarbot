# Buy My Next Car — AI Chatbot (Express + OpenAI GPT-4)

A complete, drop-in AI car-finding and finance-qualification chatbot.
Backend is plain Express.js calling OpenAI's GPT-4 directly. Frontend is a
single `iife.js` + `iife.css` pair you can paste into any website — no
build step, no framework required.

## Folder contents

```
buymynextcar-chatbot/
├── index.js          Express backend (GPT-4 chat API)
├── package.json       Backend dependencies
├── .env.example        Copy to .env and fill in your key
├── iife.js            Embeddable chat widget (vanilla JS)
├── iife.css           Widget styles
└── demo.html           Example page that loads the widget
```

## 1. Backend setup

```bash
cd buymynextcar-chatbot
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...
npm start
```

The server starts on `http://localhost:3001` by default (override with `PORT`).

### Endpoints

| Method | Path                          | Body / Params                                   | Description                  |
|--------|-------------------------------|--------------------------------------------------|-------------------------------|
| POST   | `/api/chat/message`           | `{ sessionId?, message, language? }`             | Send a message, get AI reply |
| POST   | `/api/chat/reset`             | `{ sessionId }`                                  | Clear a session's history     |
| GET    | `/api/chat/session/:sessionId`| —                                                 | Fetch session history         |
| GET    | `/health`                     | —                                                 | Health check                  |

Sessions are stored **in-memory** (a `Map`) and expire after 24 hours of
inactivity. This is fine for getting started or low-traffic use; swap in a
real database (Postgres, Redis, etc.) for production / multi-instance
deployments — the session-shaped object is intentionally simple to replace.

### CORS

By default all origins are allowed (`ALLOWED_ORIGINS=*`). Lock this down for
production by setting a comma-separated list in `.env`:

```
ALLOWED_ORIGINS=https://yoursite.com,https://www.yoursite.com
```

## 2. Frontend — embed the widget anywhere

Drop these two lines before `</body>` on any HTML page (plain HTML, WordPress,
Shopify, Webflow, anywhere that allows custom code):

```html
<link rel="stylesheet" href="https://yourcdn.com/iife.css">
<script src="https://yourcdn.com/iife.js"
        data-api-url="https://your-backend-domain.com"></script>
```

That's it — a floating chat launcher appears in the bottom-right corner.

### Configuration options

Set as attributes on the `<script>` tag:

| Attribute          | Default   | Description                                  |
|--------------------|-----------|-----------------------------------------------|
| `data-api-url`      | required  | Base URL of your backend (no trailing slash)  |
| `data-auto-open`    | `false`   | `"true"` to open the chat on page load        |
| `data-position`     | `"right"` | `"left"` or `"right"` corner placement        |

Or configure programmatically before the script tag:

```html
<script>
  window.BMNC_CONFIG = {
    apiUrl: "https://your-backend-domain.com",
    autoOpen: false,
    position: "right",
  };
</script>
<script src="iife.js"></script>
```

### JS API

Once loaded, `window.BMNCWidget` exposes:

```js
BMNCWidget.open();    // open the chat window
BMNCWidget.close();   // close it
BMNCWidget.toggle();  // toggle open/closed
BMNCWidget.reset();   // clear the conversation and start over
```

## 3. Try it locally

```bash
# Terminal 1 — backend
cd buymynextcar-chatbot
npm install && npm start

# Terminal 2 — serve the demo page (any static server works)
npx serve .
# then open http://localhost:3000/demo.html (or whatever port `serve` reports)
```

## How it works

- The widget shows a language picker (English, Mandarin, Arabic, Hindi) on
  first open, then sends that selection as the first chat message.
- Every message round-trips through `/api/chat/message`, which calls
  `gpt-4` with a system prompt that runs a structured, mandatory
  finance-qualification flow (borrow amount → residency → employment →
  personal details → income → credit score → vehicle search/LVR
  calculation), matching the same logic used in the original tRPC version.
- Conversation state is persisted both server-side (in-memory `Map`, keyed by
  `sessionId`) and client-side (`localStorage`) so refreshing the page
  resumes the same conversation.
- Markdown from GPT-4 (bold, lists, headers) is rendered with a small
  built-in parser — no external markdown library required.

## Production notes

- Replace the in-memory session `Map` with a real database for durability
  and multi-instance deployments.
- Set `ALLOWED_ORIGINS` to your actual domain(s).
- Consider rate-limiting `/api/chat/message` per IP/session to control
  OpenAI cost exposure.
- The widget never sends your OpenAI key to the browser — all calls to
  OpenAI happen server-side in `index.js`.
