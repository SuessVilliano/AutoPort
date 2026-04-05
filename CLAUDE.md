# AutoPort — AI Agent Instructions

## What This Project Is

AutoPort is a **marketplace product** for GoHighLevel (GHL) agency owners and sub-account users to port phone numbers. It is NOT an internal tool — it is customer-facing and deployed at https://auto-port.vercel.app.

## Architecture

- **Frontend**: Single-page vanilla HTML/JS/CSS app (`public/index.html`)
- **Backend**: Express.js API (`api/index.js`) deployed as Vercel serverless function
- **Twilio**: All porting operations use Twilio's Numbers API. Credentials are provided per-request by users via `X-Twilio-Account-SID` and `X-Twilio-Auth-Token` headers — never stored server-side.
- **Email**: Resend (or SendGrid) for transactional emails. Templates in `lib/emailTemplates.js`.
- **Storage**: In-memory Map (`lib/store.js`) — ephemeral on Vercel. Client uses localStorage for My Requests tracking.
- **AI Chat**: Customer-facing porting assistant. Uses Gemini 2.0 Flash or OpenAI GPT-4o-mini. Falls back to curated static responses if no AI key configured.

## Key Design Decisions

- Users provide their own Twilio/LC Phone credentials. The server has NO Twilio creds.
- No simulated or demo fallbacks — all API calls are real.
- The UI says "Account SID" and "Auth Token", NOT "Twilio" — because GHL users on LC Phone don't know it's Twilio.
- No hardcoded internal emails (migration@leadconnectorhq.com was removed).
- The AI chat works even without an API key via static response matching.

## File Structure

```
api/index.js          — Express API (all endpoints)
lib/twilioService.js  — Twilio API wrapper (creds as params)
lib/emailService.js   — Email sending (Resend/SendGrid)
lib/emailTemplates.js — 6 HTML email templates
lib/validation.js     — Phone/address/state normalization
lib/store.js          — In-memory request store
public/index.html     — Main SPA (porting wizard + My Requests + AI chat)
public/sign-loa.html  — LOA signing page
public/fix.html       — Port rejection fix page
tests/               — Jest test suite (46 tests)
```

## API Endpoints

All endpoints except `/health`, `/api/porting/requests` (GET list), `/api/porting/webhooks/twilio`, `/api/porting/generate-loa`, and `/api/porting/chat` require Twilio credentials via headers.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /health | No | Health check |
| POST | /api/porting/validate-twilio | Yes | Validate user's Twilio creds |
| POST | /api/porting/eligibility | Yes | Check number portability |
| POST | /api/porting/documents | Yes | Upload billing statement |
| POST | /api/porting/requests | Yes | Create port request |
| GET | /api/porting/requests/:sid | Yes | Get request status |
| POST | /api/porting/requests/:sid/cancel | Yes | Cancel request |
| GET | /api/porting/requests | No | List all (admin) |
| POST | /api/porting/webhooks/twilio | No | Twilio webhook receiver |
| POST | /api/porting/configure-number | Yes | Post-port webhook setup |
| POST | /api/porting/generate-loa | No | Generate LOA PDF |
| POST | /api/porting/chat | No | AI porting assistant |

## Testing

```bash
npm run test:all    # Run all 46 tests
```

## Deployment

Deployed on Vercel. Push to `main` and run `vercel --prod`.

## Environment Variables (Vercel)

- `RESEND_API_KEY` — Email sending
- `FROM_EMAIL` — Sender address (use `onboarding@resend.dev` for Resend free tier)
- `GEMINI_API_KEY` — (Optional) For AI chat assistant
- `OPENAI_API_KEY` — (Optional) Fallback for AI chat

## Common Tasks

- **Add AI to chat**: Set `GEMINI_API_KEY` env var on Vercel
- **Custom domain**: Add domain in Vercel project settings
- **Production database**: Replace `lib/store.js` with Supabase/PlanetScale
- **Email domain**: Verify domain in Resend, update `FROM_EMAIL`
