# AI Welcome Call Platform

A self-hosted platform for running **AI-powered welcome calls** with homeowners: a friendly voice assistant verifies their information and confirms — on an acknowledged, recorded line — that they understand the agreement they signed. Recordings, transcripts, and compliance flags are stored in an **admin-only dashboard**.

Built on [Vapi](https://vapi.ai) (voice AI), Express, and SQLite. Designed for one-click deploys on [Railway](https://railway.app).

## What it does

- **Public landing page** — homeowners enter their name, phone, and property address so the call is personalized to them.
- **Shareable call links** — create a call from the admin dashboard with the homeowner's info and agreement terms pre-filled, then text/email them the link. They open it, tap one button, and do the call right in their browser (works on phones — no app needed).
- **Friendly, scripted AI call** — the assistant follows your script, confirms recording consent first, verifies name / address / phone, then walks through each agreement term and collects a clear "yes" or "I understand" for each. Fully editable script in the admin panel.
- **Auto-recording** — every call is recorded by Vapi and automatically downloaded to your server's private storage. Recordings are only reachable through the password-protected admin dashboard (play in browser or download).
- **Automatic issue flagging** — after every call, the AI produces a structured analysis. Calls are flagged for human review if the homeowner: didn't consent to recording, didn't finish, was confused or hesitant, asked questions, disputed any detail, or gave corrections to the info on file. Clean calls are marked **completed**; anything else is **flagged** with the specific reasons listed.
- **Verification checklist** — per call: recording consent ✅, identity ✅, address ✅, terms ✅, completed ✅, plus full transcript and summary.
- **Optional outbound dialing** — with a Vapi phone number configured, admins can have the AI call the homeowner's phone instead of using the web link.

## Setup

### 1. Vapi account (the voice AI)

1. Create an account at [dashboard.vapi.ai](https://dashboard.vapi.ai).
2. Go to **Settings → API Keys** and copy both the **private key** and the **public key**.
3. (Optional, for outbound calls) Buy or import a phone number under **Phone Numbers** and copy its ID.

The app creates and manages its own Vapi assistant automatically — you never need to configure anything in the Vapi dashboard.

### 2. Deploy on Railway

1. Create a new Railway project → **Deploy from GitHub repo** → pick this repo.
2. Add a **Volume** to the service and mount it at `/data` (this keeps recordings and the database across deploys).
3. Set the environment variables (see `.env.example`):

   | Variable | Value |
   |---|---|
   | `VAPI_PRIVATE_KEY` | from Vapi dashboard |
   | `VAPI_PUBLIC_KEY` | from Vapi dashboard |
   | `ADMIN_PASSWORD` | a strong password for `/admin` |
   | `COMPANY_NAME` | your company's name (shown on all pages and used by the AI) |
   | `BRAND_COLOR` | your brand color, e.g. `#0f4c81` |
   | `DATA_DIR` | `/data` |
   | `APP_URL` | your public URL — set after step 4 |
   | `VAPI_PHONE_NUMBER_ID` | *(optional)* Vapi phone number ID for outbound calls |
   | `VAPI_VOICE_ID` | *(optional)* voice, default `Paige` |

4. Under **Settings → Networking**, generate a domain (or attach your own custom domain — recommended for professional branding).
5. Set `APP_URL` to that domain (e.g. `https://welcome.yourcompany.com`) and redeploy. **This step is required** — it's how Vapi delivers recordings, transcripts, and flags back to your server.

### 3. Use it

- **Admin dashboard:** `https://your-domain/admin` — create call links, review/download recordings, see flags.
- **Landing page:** `https://your-domain/` — homeowners can self-start a welcome call.
- **Call script:** `https://your-domain/admin/script` — paste your own script; placeholders like `{{homeownerName}}`, `{{propertyAddress}}`, and `{{terms}}` are filled per homeowner automatically.

## Local development

```bash
cp .env.example .env   # fill in your keys
npm install
npm start              # http://localhost:3000
```

Note: webhooks (recordings/flags) require a publicly reachable `APP_URL`; for local testing use a tunnel like `ngrok` and set `APP_URL` to the tunnel URL.

## Compliance notes (important)

This tool is built for transparent, consent-based verification, but **you are responsible for using it lawfully**:

- **Recording consent:** many US states require *all-party* consent to record calls. The default script asks for and requires verbal consent before proceeding, and calls without consent are flagged — keep that behavior in your custom script.
- **Outbound dialing:** if you enable outbound calls, TCPA and state telemarketing rules may apply (calling hours, consent to be called, AI-disclosure rules). The web-link flow, where the homeowner initiates the call themselves, is the safest default.
- **Honest identification:** the assistant identifies itself as calling on behalf of your company. Don't configure it to impersonate anyone or misrepresent who it is.
- **Data care:** recordings and personal info live in your database/volume. Restrict admin access, use a strong `ADMIN_PASSWORD`, and always run behind HTTPS (Railway domains include TLS).

## Architecture

```
Homeowner browser ──▶ Landing page ──▶ /call/<token> ──▶ Vapi Web SDK (mic call in browser)
                                                              │
Vapi cloud: runs the assistant, records the call, analyzes it │
                                                              ▼
                          POST /api/vapi/webhook (end-of-call report, secret-authenticated)
                                                              │
                    SQLite (volume) ◀── transcript, summary, flags, recording downloaded to disk
                                                              │
                                        /admin (password-protected review + downloads)
```
