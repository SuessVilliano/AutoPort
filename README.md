# AutoPort

**Phone Number Porting for GoHighLevel Agencies**

AutoPort lets GHL agency owners and sub-account users port their phone numbers through a simple, guided interface. Connect your phone account, check eligibility, upload documents, and submit — all in one place.

Live at: **https://auto-port.vercel.app**

---

## Features

- **Connect Your Account** — Enter your Account SID and Auth Token to get started. Works with LC Phone, GHL native phone, or direct Twilio accounts.
- **Real-Time Eligibility** — Instantly check if your numbers can be ported via the portability API.
- **Guided Wizard** — 6-step process: Connect → Eligibility → Info → Documents → Review → Submit.
- **Bulk CSV Import** — Upload a CSV with hundreds of numbers for batch porting.
- **LOA Generation** — Generate Letters of Authorization as PDFs (single, per-carrier, or per-number).
- **Email Notifications** — Automated status emails at every step (submission, LOA ready, submitted to carrier, FOC date, rejection, completion).
- **My Requests Dashboard** — Track all your port requests and their current status.
- **AI Porting Assistant** — Built-in chat that answers porting questions, explains rejections, and guides you through the process.
- **Port Rejection Fix Flow** — When a port is rejected, get specific fix instructions and a resubmit form.

---

## Quick Start

### For Users (Agency Owners)

1. Go to **https://auto-port.vercel.app**
2. Enter your **Account SID** and **Auth Token**
   - **GHL / LC Phone**: Settings → Phone Integration
   - **Twilio Direct**: console.twilio.com dashboard
3. Follow the wizard to port your numbers

### For Developers

```bash
# Clone
git clone https://github.com/SuessVilliano/AutoPort.git
cd AutoPort

# Install
npm install

# Run locally
npm start
# → http://localhost:3000

# Run tests
npm run test:all
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | Yes | Resend.com API key for sending emails |
| `FROM_EMAIL` | No | Sender email (default: `onboarding@resend.dev`) |
| `SENDGRID_API_KEY` | No | Alternative to Resend |
| `GEMINI_API_KEY` | No | Google Gemini for AI chat assistant |
| `OPENAI_API_KEY` | No | OpenAI fallback for AI chat |
| `GHL_WEBHOOK_BASE` | No | GHL webhook URL for post-port config |

> **Note**: Twilio credentials are provided by each user through the UI. They are sent via request headers and never stored on the server.

---

## How Porting Works

1. **Connect** — User provides their Account SID + Auth Token. We validate against the Twilio API.
2. **Eligibility** — Each phone number is checked via Twilio's Portability API.
3. **Information** — User enters account holder name, address, and carrier details (must match carrier records exactly).
4. **Documents** — User uploads their phone bill (PDF). Uploaded to Twilio Documents API.
5. **Review & Submit** — Port request is created via Twilio's Port-In API. User receives confirmation email.
6. **LOA Signing** — Twilio sends an LOA to sign electronically. User has 30 days.
7. **Carrier Processing** — Takes 5-15 business days. Status updates sent via email at each step.
8. **Completion** — Number is live. User can now configure it in GHL.

---

## API Reference

### Authentication

All porting endpoints require these headers:

```
X-Twilio-Account-SID: ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
X-Twilio-Auth-Token: your_auth_token
```

### Endpoints

#### `POST /api/porting/validate-twilio`
Validate account credentials.

#### `POST /api/porting/eligibility`
```json
{ "phoneNumbers": ["+13125889960", "+18475551234"] }
```

#### `POST /api/porting/requests`
Create a port request. Accepts multipart form with `data` (JSON string) and `billingStatement` (PDF file).

#### `GET /api/porting/requests/:sid`
Get port request status.

#### `POST /api/porting/chat`
```json
{ "message": "How long does porting take?", "history": [] }
```

#### `POST /api/porting/generate-loa`
Generate LOA PDF. Returns `application/pdf`.

See [CLAUDE.md](CLAUDE.md) for the full endpoint table.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5 + Vanilla JS + CSS3 |
| Backend | Node.js + Express.js |
| Deployment | Vercel (serverless) |
| Phone Porting | Twilio Numbers API |
| Email | Resend / SendGrid |
| AI Assistant | Google Gemini 2.0 Flash / OpenAI GPT-4o-mini |
| PDF Generation | PDFKit |
| Testing | Jest + Supertest |

---

## Testing

```bash
npm run test:all
```

46 tests covering:
- API endpoint authentication
- Input validation
- LOA generation
- Email templates (no internal references)
- Frontend content verification
- Webhook handling
- In-memory store operations

---

## Deployment

Hosted on Vercel. Pushes to `main` auto-deploy, or manually:

```bash
vercel --prod
```

---

## License

Proprietary — Hybrid Holdings
