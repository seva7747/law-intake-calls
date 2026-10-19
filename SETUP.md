# Setup guide: AI intake phone line

Caller dials your Twilio number -> Twilio listens and speaks (ConversationRelay) -> your server asks Claude what to say -> the call is summarized, saved, and emailed to lawclerk@tsivyanesq.com. Calls also show on the dashboard website.

## What you need (accounts and keys)
| Item | Where | Cost (approx.) |
|---|---|---|
| Twilio account + phone number | twilio.com | ~$1.15/mo number + ~$0.02-0.03/min for voice and speech |
| Anthropic API key | console.anthropic.com -> API Keys | pay as you go, a few cents per call |
| Email sending login (SMTP) | e.g. a Gmail App Password | free |
| Hosting (so it runs 24/7) | render.com or railway.app | ~$7/mo |
| ngrok (testing only) | ngrok.com | free |

## Step 1: Get the keys
1. **Twilio**: sign up, upgrade out of trial (trial plays a "trial account" message and only calls verified numbers). Console home page shows **Account SID** and **Auth Token**; you need the **Auth Token**.
2. Twilio Console -> **Phone Numbers -> Buy a number** with Voice capability. (Or send me the number; it's only entered in Twilio, never in the code.)
3. Twilio Console -> **Voice -> Settings -> General** -> turn on **Predictive and Generative AI/ML Features Addendum** (required for ConversationRelay; accept the terms).
4. **Anthropic**: create an account, add a few dollars of credit, create an API key.
5. **Gmail App Password** (for sending the summary email): on the Gmail account that will send, turn on 2-Step Verification, then myaccount.google.com/apppasswords -> create one. Use that 16-character password as `SMTP_PASS` and the Gmail address as `SMTP_USER`.

## Step 2: Configure the project
1. In this folder, copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`).
2. Fill in: `ANTHROPIC_API_KEY`, `TWILIO_AUTH_TOKEN`, `SMTP_USER`, `SMTP_PASS`, `DASHBOARD_PASSWORD` (anything strong), and `FIRM_NAME` / `ATTORNEY_NAME` (what the AI says out loud; I guessed these from the email domain, so correct them).
3. Leave `PUBLIC_URL` for Step 3.

## Step 3: Test on your computer
1. Install ngrok, then in a terminal: `ngrok http 3000`. Copy the `https://....ngrok-free.app` URL into `PUBLIC_URL` in `.env`.
2. In another terminal in this folder: `npm start` (you should see "Intake server running on port 3000").
3. Twilio Console -> **Phone Numbers -> Manage -> Active numbers** -> click your number -> **Voice Configuration**:
   - "A call comes in": **Webhook**, URL `https://YOUR-URL/voice`, method **HTTP POST**. Save.
4. Call your number from your cell. Talk through a fake landlord-tenant story. Hang up, then check the dashboard at `https://YOUR-URL/` (user `admin`, your dashboard password) and the clerk inbox.

## Step 4: Go live (24/7)
ngrok stops when your PC sleeps, so deploy:
1. Put this folder on GitHub (the `.env` and `data` are ignored; don't commit secrets).
2. On **Render**: New -> Web Service -> connect the repo. Build command `npm install`, start command `npm start`. Add every `.env` value under Environment, with `PUBLIC_URL` = your Render URL (e.g. `https://intake.onrender.com`).
3. Use a paid instance (free ones sleep and the first call would fail). Add a **Disk** mounted at `/opt/render/project/src/data` so saved calls survive restarts (emails still arrive either way).
4. Change the Twilio number's webhook to `https://intake.onrender.com/voice`.
5. To have it answer your father's existing line, set that line to forward to the Twilio number (his carrier's call forwarding on no-answer/busy), or publish the Twilio number.

## Tuning
- **What it says/asks**: edit `prompt.js`.
- **Voice**: `TTS_VOICE` in `.env`. Google "en-US-Journey-O" / "-F" are natural. For the most human sound, set `TTS_PROVIDER=ElevenLabs` and use an ElevenLabs voice ID (Twilio's ConversationRelay supports it; usage billed through Twilio).
- **Speed vs. quality**: `CLAUDE_MODEL=claude-haiku-5-5` is faster/cheaper; Sonnet is smarter.

## Legal and ethical notes (please review with your father)
- The AI discloses it's an AI and gives no legal advice. Keep that.
- Calls are **not recorded**; only the transcript is stored. If you add recording, you must follow your state's consent rules.
- Transcripts contain confidential client info: use a strong dashboard password, keep the server private, and check state bar guidance on using AI vendors (Anthropic, Twilio) with client data.
- The AI can't receive attachments by voice. Callers email the lease to lawclerk@tsivyanesq.com (the AI tells them to put their name and phone number in the subject line).
