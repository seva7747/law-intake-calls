require("dotenv").config();
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const nodemailer = require("nodemailer");
const { buildSystemPrompt, SUMMARY_PROMPT } = require("./prompt");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const DATA_FILE = path.join(__dirname, "data", "intakes.json");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------- storage (simple JSON file) ----------
function loadIntakes() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveIntake(record) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const all = loadIntakes();
  all.unshift(record);
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
}

// ---------- Twilio webhook: call comes in here ----------
function publicHost() {
  return (process.env.PUBLIC_URL || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

app.post("/voice", (req, res) => {
  // Verify the request is really from Twilio
  if (process.env.TWILIO_AUTH_TOKEN) {
    const sig = req.headers["x-twilio-signature"];
    const url = `https://${publicHost()}/voice`;
    if (!twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, sig, url, req.body)) {
      return res.status(403).send("Invalid signature");
    }
  }
  const firm = process.env.FIRM_NAME || "the law office";
  const greeting =
    `Hi, thanks for calling ${firm}. I'm the office's AI assistant, and I'll take down some details so the team can follow up with you. ` +
    `So, tell me a little about what's going on with your case.`;

  const provider = process.env.TTS_PROVIDER || "Google";
  const voice = process.env.TTS_VOICE || "en-US-Journey-O";

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${publicHost()}/relay"
      welcomeGreeting="${esc(greeting)}"
      ttsProvider="${esc(provider)}" voice="${esc(voice)}"
      transcriptionProvider="Deepgram" speechModel="nova-3-general"
      language="en-US" interruptible="true" dtmfDetection="true" />
  </Connect>
</Response>`);
});

// ---------- the live conversation (WebSocket from Twilio) ----------
const END_TOOL = {
  name: "end_call",
  description: "Hang up the call. Use only after you have said goodbye to the caller.",
  input_schema: { type: "object", properties: {}, required: [] },
};

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  const call = { sid: null, from: null, startedAt: new Date().toISOString(), messages: [], abort: null, busy: false };
  const system = buildSystemPrompt();

  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  async function respond() {
    call.busy = true;
    const ctrl = new AbortController();
    call.abort = ctrl;
    let spoken = "";
    try {
      const stream = anthropic.messages.stream(
        { model: MODEL, max_tokens: 400, system, tools: [END_TOOL], messages: call.messages },
        { signal: ctrl.signal }
      );
      stream.on("text", (t) => {
        spoken += t;
        send({ type: "text", token: t, last: false });
      });
      const final = await stream.finalMessage();
      send({ type: "text", token: "", last: true });
      call.messages.push({ role: "assistant", content: spoken.trim() || "..." });
      if (final.content.some((b) => b.type === "tool_use" && b.name === "end_call")) {
        setTimeout(() => send({ type: "end" }), 4000); // let the goodbye finish playing
      }
    } catch (err) {
      if (ctrl.signal.aborted) return; // caller interrupted; handled in 'interrupt'
      console.error("Claude error:", err.message);
      const fallback = "I'm sorry, I had a little trouble there. Could you say that again?";
      send({ type: "text", token: fallback, last: true });
      call.messages.push({ role: "assistant", content: fallback });
    } finally {
      call.busy = false;
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "setup":
        call.sid = msg.callSid;
        call.from = msg.from;
        call.messages.push({
          role: "user",
          content: "[The call just connected. The greeting asking about their case was already spoken.]",
        });
        call.messages.push({
          role: "assistant",
          content: "Hi, thanks for calling. I'm the office's AI assistant. Tell me a little about what's going on with your case.",
        });
        break;
      case "prompt": {
        if (!msg.last || !msg.voicePrompt?.trim()) break;
        if (call.abort && call.busy) call.abort.abort();
        const last = call.messages[call.messages.length - 1];
        if (last && last.role === "user") {
          last.content += " " + msg.voicePrompt; // merge consecutive user turns
        } else {
          call.messages.push({ role: "user", content: msg.voicePrompt });
        }
        respond();
        break;
      }
      case "interrupt": {
        if (call.abort && call.busy) call.abort.abort();
        // keep only what the caller actually heard
        const last = call.messages[call.messages.length - 1];
        if (last && last.role === "assistant" && msg.utteranceUntilInterrupt) {
          last.content = msg.utteranceUntilInterrupt;
        }
        break;
      }
      case "dtmf":
        break;
      case "error":
        console.error("Twilio error:", msg.description);
        break;
    }
  });

  ws.on("close", () => finishCall(call).catch((e) => console.error("finishCall failed:", e)));
});

// ---------- after the call: summarize, save, email ----------
function transcriptText(messages) {
  return messages
    .filter((m) => typeof m.content === "string" && !m.content.startsWith("[The call just connected"))
    .map((m) => `${m.role === "user" ? "CALLER" : "ASSISTANT"}: ${m.content}`)
    .join("\n");
}

async function finishCall(call) {
  const transcript = transcriptText(call.messages);
  const callerSaid = call.messages.filter((m) => m.role === "user").length > 1;
  if (!callerSaid) return; // hang-up before saying anything

  let summary = {};
  try {
    const r = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SUMMARY_PROMPT,
      messages: [{ role: "user", content: transcript }],
    });
    const text = r.content.map((b) => b.text || "").join("");
    summary = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch (e) {
    console.error("Summary failed:", e.message);
    summary = { summary: "(Automatic summary failed. See transcript.)" };
  }

  const record = {
    id: call.sid || String(Date.now()),
    startedAt: call.startedAt,
    endedAt: new Date().toISOString(),
    from: call.from,
    summary,
    transcript,
  };
  saveIntake(record);
  console.log("Saved intake", record.id);
  await emailSummary(record).catch((e) => console.error("Email failed:", e.message));
}

async function emailSummary(r) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return console.log("SMTP not configured; skipping email.");
  const s = r.summary;
  const list = (a) => (a && a.length ? a.map((x) => `  - ${x}`).join("\n") : "  (none)");
  const body = `${s.urgent ? "*** URGENT: " + (s.urgency_reason || "") + " ***\n\n" : ""}NEW INTAKE CALL
Time: ${new Date(r.startedAt).toLocaleString()}
Caller ID: ${r.from}
Name: ${s.caller_name || "unknown"}
Callback number (as stated): ${s.callback_number || "unknown"}
Email: ${s.caller_email || "unknown"}
Matter: ${s.matter_type || "unknown"}
Property: ${s.property_address || "-"}
Other party: ${s.other_party || "-"}

SUMMARY
${s.summary || ""}

KEY FACTS
${list(s.key_facts)}

DOCUMENTS CALLER WAS ASKED TO EMAIL
${list(s.documents_requested)}

DESIRED OUTCOME
${s.desired_outcome || "-"}

STILL TO ASK
${list(s.follow_up_questions)}

NOTES
${s.call_quality_notes || "-"}

----- FULL TRANSCRIPT -----
${r.transcript}
`;
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.SUMMARY_TO || process.env.INTAKE_EMAIL,
    subject: `${s.urgent ? "[URGENT] " : ""}Intake call: ${s.caller_name || r.from || "unknown"} - ${s.matter_type || "new matter"}`,
    text: body,
  });
}

// ---------- dashboard website (password protected) ----------
function requireLogin(req, res, next) {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return res.status(500).send("Set DASHBOARD_PASSWORD in .env");
  const h = req.headers.authorization || "";
  const [user, pass] = Buffer.from(h.replace(/^Basic /, ""), "base64").toString().split(/:(.*)/s);
  if (user === "admin" && pass === pw) return next();
  res.set("WWW-Authenticate", 'Basic realm="Intake Dashboard"').status(401).send("Login required");
}
app.get("/api/intakes", requireLogin, (req, res) => res.json(loadIntakes()));
app.use("/", requireLogin, express.static(path.join(__dirname, "public")));

server.listen(PORT, () => console.log(`Intake server running on port ${PORT}`));
