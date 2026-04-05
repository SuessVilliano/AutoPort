// ─────────────────────────────────────────────────────────
//  AutoPort — Marketplace Edition
//  Single Express app exported as a serverless function.
//  All Twilio credentials provided per-request via headers.
// ─────────────────────────────────────────────────────────

const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const fetch    = require('node-fetch');

const twilio     = require('../lib/twilioService');
const validation = require('../lib/validation');
const store      = require('../lib/store');
const emailSvc   = require('../lib/emailService');

const app = express();

// ── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── File upload — memory storage (no disk on Vercel) ───────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are accepted'));
    }
    cb(null, true);
  },
});

// ── Extract Twilio credentials from request headers ───────
function extractTwilioCreds(req) {
  return {
    accountSid: req.headers['x-twilio-account-sid'] || req.headers['x-twilio-sid'],
    authToken:  req.headers['x-twilio-auth-token']  || req.headers['x-twilio-token'],
  };
}

function requireTwilioCreds(req, res, next) {
  const creds = extractTwilioCreds(req);
  if (!creds.accountSid || !creds.authToken) {
    return res.status(401).json({
      error: 'Twilio credentials required. Connect your Twilio account first.',
    });
  }
  req.twilioCreds = creds;
  next();
}

// ═══════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'autoport-marketplace',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    env: {
      emailConfigured: !!(process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY),
      emailProvider:   process.env.SENDGRID_API_KEY ? 'sendgrid' : process.env.RESEND_API_KEY ? 'resend' : 'console',
    },
  });
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/validate-twilio
//  Validate that user-provided Twilio credentials work.
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/validate-twilio', requireTwilioCreds, async (req, res) => {
  try {
    const account = await twilio.validateCredentials(req.twilioCreds);
    res.json({
      valid: true,
      friendlyName: account.friendly_name,
      status: account.status,
      type: account.type,
    });
  } catch (err) {
    res.status(401).json({
      valid: false,
      error: err.status === 401
        ? 'Invalid credentials. Check your Account SID and Auth Token.'
        : err.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/eligibility
//  Check if one or more phone numbers can be ported.
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/eligibility', requireTwilioCreds, async (req, res) => {
  try {
    const { phoneNumbers } = req.body;

    if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      return res.status(400).json({ error: 'phoneNumbers array is required' });
    }

    const results = await Promise.all(
      phoneNumbers.map(async (number) => {
        const normalized = validation.normalizePhone(number);
        if (!normalized) {
          return { number, portable: false, reason: 'Invalid phone number format', type: 'UNKNOWN' };
        }
        const type = validation.detectNumberType(normalized);
        if (type === 'TOLL_FREE') {
          return { number: normalized, portable: false, reason: 'Toll-free numbers require manual porting', type: 'TOLL_FREE' };
        }

        try {
          const result = await twilio.checkPortability(normalized, req.twilioCreds, req.twilioCreds.accountSid);
          return {
            number: normalized,
            portable: result.portable,
            pinRequired: result.pin_and_account_number_required,
            type: result.number_type || type,
            reason: result.not_portable_reason || null,
          };
        } catch (twilioErr) {
          return {
            number: normalized,
            portable: false,
            reason: `Twilio error: ${twilioErr.message}`,
            type,
          };
        }
      })
    );

    res.json({ results });
  } catch (err) {
    console.error('Eligibility check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/documents
//  Upload billing statement PDF.
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/documents', requireTwilioCreds, upload.single('billingStatement'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'billingStatement PDF file is required' });
    }

    const doc = await twilio.uploadDocument(
      req.file.buffer,
      req.file.originalname,
      req.twilioCreds,
      req.twilioCreds.accountSid
    );

    res.json({
      success: true,
      documentSid: doc.sid,
      filename: req.file.originalname,
      size: req.file.size,
    });
  } catch (err) {
    console.error('Document upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/requests
//  Create a new port-in request.
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/requests', requireTwilioCreds, upload.single('billingStatement'), async (req, res) => {
  try {
    let data;
    try {
      data = typeof req.body.data === 'string' ? JSON.parse(req.body.data) : req.body;
    } catch {
      data = req.body;
    }

    // 1. Validate
    const validResult = validation.validatePortRequest(data);
    if (!validResult.valid) {
      return res.status(400).json({ error: 'Validation failed', errors: validResult.errors });
    }

    // 2. Normalize state
    data.address.state = validation.normalizeState(data.address.state);

    // 3. Normalize phone numbers
    data.phoneNumbers = data.phoneNumbers.map(n => ({
      ...n,
      number: validation.normalizePhone(n.number),
    }));

    // 4. Upload billing statement if provided
    let documentSid = data.documentSid;
    if (req.file && !documentSid) {
      const doc = await twilio.uploadDocument(
        req.file.buffer,
        req.file.originalname,
        req.twilioCreds,
        req.twilioCreds.accountSid
      );
      documentSid = doc.sid;
    }
    if (documentSid) data.documentSids = [documentSid];

    // 5. Create port request in Twilio
    const portResult = await twilio.createPortInRequest(data, req.twilioCreds, req.twilioCreds.accountSid);
    const portSid = portResult.sid;

    // 6. Save to store
    const requestRecord = {
      id: portSid,
      portInSid: portSid,
      customerName: data.customerName,
      businessName: data.businessName || null,
      email: data.authorizedRepresentativeEmail,
      ccEmails:  (data.ccEmails  || []).filter(Boolean),
      bccEmails: (data.bccEmails || []).filter(Boolean),
      address: data.address,
      phoneNumbers: data.phoneNumbers,
      status: 'waiting_for_signature',
      documentSid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveRequest(portSid, requestRecord);

    // 7. Fire confirmation email (non-blocking)
    emailSvc.sendSubmissionConfirmation({
      customerName:     data.customerName,
      email:            data.authorizedRepresentativeEmail,
      ccEmails:         requestRecord.ccEmails,
      bccEmails:        requestRecord.bccEmails,
      portInRequestSid: portSid,
      phoneNumbers:     data.phoneNumbers,
      estimatedDays:    '5–15 business days',
    }).catch(e => console.error('Email send error:', e));

    res.status(201).json({
      success: true,
      portInRequestSid: portSid,
      status: 'waiting_for_signature',
      message: 'Port request created. Check your email to sign the LOA.',
      estimatedCompletionDays: '5-15 business days',
    });
  } catch (err) {
    console.error('Create port request error:', err);
    res.status(500).json({ error: err.message, twilioCode: err.twilioCode });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /api/porting/requests/:sid
//  Get status of a port request.
// ═══════════════════════════════════════════════════════════
app.get('/api/porting/requests/:sid', requireTwilioCreds, async (req, res) => {
  try {
    const { sid } = req.params;

    // Try live status from Twilio first
    try {
      const twilioStatus = await twilio.getPortRequestStatus(sid, req.twilioCreds);
      res.json({
        id: sid,
        portInSid: sid,
        status: twilioStatus.status,
        ...twilioStatus,
      });
      return;
    } catch (_e) {
      // Fall back to local store
    }

    const local = store.getRequest(sid);
    if (!local) {
      return res.status(404).json({ error: 'Port request not found' });
    }

    res.json({ ...local });
  } catch (err) {
    console.error('Get request error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/requests/:sid/cancel
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/requests/:sid/cancel', requireTwilioCreds, async (req, res) => {
  try {
    const { sid } = req.params;
    await twilio.cancelPortRequest(sid, req.twilioCreds);
    store.updateRequest(sid, { status: 'canceled' });
    res.json({ success: true, status: 'canceled' });
  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/webhooks/twilio
//  Receives real-time status updates from Twilio.
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/webhooks/twilio', (req, res) => {
  try {
    res.sendStatus(200);

    const payload = req.body;
    const sid = payload.port_in_request_sid;
    const status = payload.status;
    const phoneNumber = payload.phone_number;
    const rejectionReason = payload.rejection_reason;

    console.log(`[WEBHOOK] ${sid} → ${status}`, phoneNumber ? `(${phoneNumber})` : '');

    if (!sid) return;

    const updates = { status, updatedAt: new Date().toISOString() };
    if (rejectionReason) updates.rejectionReason = rejectionReason;
    if (phoneNumber) updates.lastUpdatedNumber = phoneNumber;
    const updatedRecord = store.updateRequest(sid, updates);

    if (updatedRecord) {
      emailSvc.dispatchWebhookEmail(payload, updatedRecord)
        .catch(e => console.error('[EMAIL DISPATCH ERROR]', e));
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/configure-number
//  Attach GHL SMS/voice webhooks after port completes.
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/configure-number', requireTwilioCreds, async (req, res) => {
  try {
    const { incomingPhoneNumberSid, accountSid, locationId } = req.body;

    const baseUrl = process.env.GHL_WEBHOOK_BASE || 'https://services.leadconnectorhq.com';
    const webhookConfig = {
      smsUrl:   `${baseUrl}/twilio/sms/${locationId}`,
      voiceUrl: `${baseUrl}/twilio/voice/${locationId}`,
      smsMethod:   'POST',
      voiceMethod: 'POST',
    };

    await twilio.configurePortedNumber(incomingPhoneNumberSid, req.twilioCreds, accountSid, webhookConfig);
    res.json({ success: true, configured: webhookConfig });
  } catch (err) {
    console.error('Configure number error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /api/porting/requests (list all from store)
// ═══════════════════════════════════════════════════════════
app.get('/api/porting/requests', (_req, res) => {
  res.json({ requests: store.getAllRequests() });
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/chat
//  Customer-facing AI porting assistant.
//  Helps users with porting questions, rejections, timelines.
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/chat', async (req, res) => {
  try {
    let { message, history } = req.body;
    if (typeof history === 'string') {
      try { history = JSON.parse(history); } catch { history = []; }
    }
    if (!message) {
      return res.status(400).json({ error: 'Message required' });
    }

    const systemPrompt = `You are AutoPort Assistant — a friendly, expert phone number porting advisor built into the AutoPort marketplace app. You help GoHighLevel agency owners and sub-account users port their phone numbers.

YOUR EXPERTISE:
- Phone number porting process (how it works, timelines, requirements)
- LOA (Letter of Authorization) — what it is, why it's needed, how to sign
- Common port rejection reasons and exactly how to fix each one
- Twilio porting API specifics (you work on top of Twilio's infrastructure)
- LC Phone / GHL native phone system (users may not know it's Twilio underneath)
- Carrier-specific quirks (AT&T, Verizon, T-Mobile, etc.)
- A2P 10DLC registration requirements after porting
- Toll-free vs local vs mobile number differences
- Bulk porting (CSV uploads, batch LOAs)
- Post-port configuration (webhooks, GHL workflows)

KEY FACTS TO ALWAYS REMEMBER:
- Standard ports take 5-15 business days
- Toll-free ports take 2-4 weeks and require manual handling
- International ports require Twilio's separate international form
- Users MUST keep their numbers active with current carrier until port completes
- SMS may be unavailable for up to 3 business days after porting
- The #1 rejection reason is name/address mismatch with carrier records
- Users need Account SID + Auth Token from their phone system dashboard
- For GHL/LC Phone users: Settings → Phone Integration → Account SID & Auth Token
- For direct Twilio users: console.twilio.com dashboard
- After porting, users should register for A2P 10DLC to send business SMS
- LOAs must match carrier records EXACTLY — including middle initials, Inc/LLC, etc.

COMMON REJECTION FIXES:
- NAME_MISMATCH: Call carrier, ask for exact name on account. Business? Include LLC/Inc.
- ADDRESS_MISMATCH: Call carrier for exact service address on file. PO Box vs street matters.
- ACCOUNT_NUMBER: Found on monthly bill or by calling carrier.
- PIN_INCORRECT: Call carrier to confirm or reset PIN. Some carriers use last 4 SSN.
- NUMBER_ACTIVE: Ensure number hasn't been disconnected. Reactivate with carrier first.

TONE: Friendly, clear, action-oriented. Give specific steps, not vague advice. If you don't know something, say so — don't guess. Keep answers concise but thorough enough to actually solve the problem.

IMPORTANT: You are customer-facing, not an internal tool. Never reference internal systems, migration teams, or support emails. You ARE the support.`;

    // 1. Try static responses first — saves AI credits for complex questions
    let reply = getStaticResponse(message);
    let source = 'static';

    // 2. If static didn't match, try AI providers
    if (!reply) {
      const groqKey   = process.env.GROQ_API_KEY;
      const geminiKey = process.env.GEMINI_API_KEY;
      const openaiKey = process.env.OPENAI_API_KEY;

      // Groq (primary — free, fast)
      if (groqKey) {
        try {
          const messages = [
            { role: 'system', content: systemPrompt },
            ...(history || []).map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: message }
          ];
          const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, temperature: 0.3, max_tokens: 1500 })
          });
          const data = await resp.json();
          reply = data.choices?.[0]?.message?.content || null;
          if (reply) source = 'groq';
          else console.warn('Groq returned no content:', JSON.stringify(data.error || {}).substring(0, 200));
        } catch (e) {
          console.warn('Groq error:', e.message);
        }
      }

      // Gemini (fallback)
      if (!reply && geminiKey) {
        try {
          const historyParts = (history || []).map(h => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }]
          }));
          const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [...historyParts, { role: 'user', parts: [{ text: message }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 1500 }
            })
          });
          const data = await resp.json();
          reply = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
          if (reply) source = 'gemini';
        } catch (e) {
          console.warn('Gemini error:', e.message);
        }
      }

      // OpenAI (last resort)
      if (!reply && openaiKey) {
        try {
          const messages = [
            { role: 'system', content: systemPrompt },
            ...(history || []).map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: message }
          ];
          const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
            body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.3, max_tokens: 1500 })
          });
          const data = await resp.json();
          reply = data.choices?.[0]?.message?.content || null;
          if (reply) source = 'openai';
        } catch (e) {
          console.warn('OpenAI error:', e.message);
        }
      }

      // Final fallback — generic help menu
      if (!reply) {
        reply = getGenericHelp();
        source = 'fallback';
      }
    }

    res.json({ success: true, reply, source });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
//  Smart static responses — handles 90% of porting questions
//  without burning AI credits. Returns null if no match.
// ─────────────────────────────────────────────────────────
function getStaticResponse(message) {
  const q = message.toLowerCase();

  // --- TIMELINES ---
  if (q.includes('how long') || q.includes('timeline') || q.includes('how many days') || q.includes('when will') || q.includes('how fast') || q.includes('time does it take'))
    return 'Standard phone number ports take **5-15 business days**. Here\'s the breakdown:\n\n- **LOA signing**: 1-2 days (depends on you)\n- **Carrier processing**: 3-10 business days\n- **Toll-free numbers**: 2-4 weeks (separate process)\n- **Bulk ports (50+ numbers)**: 6-8 weeks\n\nThe biggest delays come from LOA signing delays and information mismatches. Make sure your name and address match your carrier records exactly.';

  // --- REJECTIONS ---
  if (q.includes('reject') || q.includes('denied') || q.includes('failed') || q.includes('not approved'))
    return 'Port rejections are common and almost always fixable. Here are the top reasons and exact fixes:\n\n**1. Name Mismatch** (most common)\n→ Call your carrier and ask: "What exact name is on my account?"\n→ Include LLC, Inc, Jr, middle initials — must match exactly\n\n**2. Address Mismatch**\n→ Ask your carrier for the "service address on file"\n→ It may differ from your mailing/billing address\n\n**3. Wrong Account Number**\n→ Check your latest phone bill (top right corner usually)\n→ Or call your carrier and ask\n\n**4. Wrong PIN**\n→ Call your carrier: "What is my account PIN or transfer PIN?"\n→ Some carriers use last 4 of SSN instead\n\n**5. Number Not Active**\n→ Make sure your number is still active with your carrier\n→ If disconnected, reactivate it first, then try again\n\nUse the **fix link in your rejection email** to correct and resubmit.';

  // --- LOA ---
  if (q.includes('loa') || q.includes('letter of auth') || q.includes('authorization'))
    return 'The **Letter of Authorization (LOA)** is a legal document required by the FCC for all number ports. Here\'s what you need to know:\n\n**What it does:** Authorizes the transfer of your phone number from your current carrier.\n\n**How to sign:** After submitting your port request, you\'ll receive an email with a digital signing link. Click it, review the details, and sign electronically.\n\n**Time limit:** You have **30 days** to sign. After that, the request expires and you\'ll need to resubmit.\n\n**Critical:** The name and address on the LOA must match your carrier\'s records **exactly**. This is the #1 cause of rejections.\n\n**LOA modes:**\n- **Single LOA** — One document for all numbers (same carrier/account holder)\n- **Per-carrier** — Separate LOA for each carrier (mixed-carrier batches)\n- **Per-number** — Individual LOA per number (different account holders)';

  // --- CREDENTIALS ---
  if (q.includes('account sid') || q.includes('auth token') || q.includes('credentials') || q.includes('where do i find') || q.includes('how do i connect') || q.includes('sid and token') || q.includes('where is my'))
    return 'Here\'s where to find your Account SID and Auth Token:\n\n**GoHighLevel / LC Phone:**\n1. Log into your GHL account\n2. Go to **Settings** → **Phone Integration**\n3. Your **Account SID** (starts with AC) and **Auth Token** are displayed there\n\n**Direct Twilio:**\n1. Go to **console.twilio.com**\n2. Both are on the main dashboard page\n\n**Tips:**\n- Account SID always starts with **"AC"** and is 34 characters\n- Auth Token is a 32-character string\n- If porting to a subaccount, use that subaccount\'s SID\n- Your credentials are sent securely and never stored on our servers';

  // --- TOLL-FREE ---
  if (q.includes('toll') || q.includes('800') || q.includes('888') || q.includes('877') || q.includes('866') || q.includes('855'))
    return 'Toll-free numbers (800, 833, 844, 855, 866, 877, 888) have a **different porting process**:\n\n- They take **2-4 weeks** (longer than local numbers)\n- They require a **RespOrg change** to TWI01 (Twilio\'s RespOrg ID)\n- AutoPort will detect toll-free numbers during eligibility and flag them\n- You\'ll need to use Twilio\'s international/toll-free porting form\n\n**Important:** After the RespOrg change, do NOT cancel your toll-free service for 10 days.';

  // --- CANCEL / KEEP ACTIVE ---
  if (q.includes('cancel') || q.includes('keep active') || q.includes('disconnect') || q.includes('turn off'))
    return '**Do NOT cancel your current carrier service** until the port is 100% complete.\n\nHere\'s why:\n- If you cancel early, the port **will fail** and you could lose your number permanently\n- Your carrier needs the number to be active to process the transfer\n- Keep paying your current carrier until you receive the **"Port Complete"** email\n- After the port is done, you can safely cancel your old service\n\nYou\'ll receive email updates at every step so you always know the status.';

  // --- SMS / A2P / 10DLC ---
  if (q.includes('sms') || q.includes('text') || q.includes('a2p') || q.includes('10dlc') || q.includes('messaging'))
    return 'After porting, here\'s what to know about SMS:\n\n**SMS Downtime:** Text messaging may be unavailable for **up to 3 business days** after porting. This is normal and handled automatically.\n\n**A2P 10DLC Registration** (required for business SMS):\n- All businesses sending SMS must register for A2P 10DLC\n- Register your brand and campaign in your GHL account or Twilio console\n- Without registration, carriers will block your messages\n- Registration takes 1-7 business days to approve\n\n**MMS:** Picture messaging works the same as SMS — may have brief downtime after port.\n\n**Voice:** Phone calls work immediately after porting. No downtime.';

  // --- BULK / CSV ---
  if (q.includes('bulk') || q.includes('csv') || q.includes('multiple') || q.includes('batch') || q.includes('many numbers') || q.includes('upload'))
    return 'For bulk porting, here\'s how to use the CSV import:\n\n**Step 1:** Download the CSV template from the eligibility step\n\n**CSV Format:**\n```\nphone_number,contact_name,type,account_number,pin\n+13125889960,John Smith,LOCAL,,\n+13125550001,Jane Doe,MOBILE,ACC123,1234\n```\n\n**Columns:**\n- **phone_number** (required) — US format with +1\n- **contact_name** (optional)\n- **type** — LOCAL or MOBILE\n- **account_number** (optional)\n- **pin** (optional)\n\n**Tips:**\n- One number per row\n- Duplicates are automatically removed\n- All numbers on a single LOA must have the same account holder\n- For 50+ numbers, ports can take 6-8 weeks\n- Use "per-carrier" LOA mode for mixed-carrier batches';

  // --- CARRIER-SPECIFIC ---
  if (q.includes('at&t') || q.includes('att'))
    return '**AT&T Porting Tips:**\n\n- Account number is on your bill (top right, usually 9-12 digits)\n- Transfer PIN: Call 611 from your AT&T phone or call 1-800-331-0500\n- Ask for a "transfer PIN" or "port-out PIN" — it\'s different from your account PIN\n- AT&T business accounts may need an authorized user to request the port\n- AT&T typically processes ports in 3-5 business days';

  if (q.includes('verizon'))
    return '**Verizon Porting Tips:**\n\n- Account number: Found on your bill or in My Verizon app\n- PIN: Set one at verizon.com → Account → PIN Management, or call *611\n- Verizon uses a 4-digit PIN by default\n- For business accounts, you may need to go to a Verizon store with ID\n- Verizon typically processes ports in 3-7 business days';

  if (q.includes('t-mobile') || q.includes('tmobile'))
    return '**T-Mobile Porting Tips:**\n\n- Account number: Found on your bill or call 611\n- PIN: Set or reset at my.t-mobile.com or by calling 611\n- T-Mobile uses a 6-15 digit PIN\n- If you have a "number lock" or "port protection" enabled, you\'ll need to disable it first (call 611)\n- T-Mobile typically processes ports in 2-5 business days';

  if (q.includes('sprint'))
    return '**Sprint Porting Tips:**\n\nSprint has merged with T-Mobile. Your account should now be under T-Mobile.\n\n- Call T-Mobile at 611 or 1-800-937-8997\n- Ask for your account number and transfer PIN\n- Disable any "port freeze" or "number lock" features\n- Some legacy Sprint accounts may require visiting a store';

  // --- ELIGIBILITY ---
  if (q.includes('eligible') || q.includes('eligibility') || q.includes('can i port') || q.includes('portable') || q.includes('not portable'))
    return 'Most US local and mobile numbers are portable. Here are the exceptions:\n\n**Can be ported:**\n- Local landline numbers\n- Mobile/wireless numbers\n- VoIP numbers (most)\n\n**Cannot be ported through AutoPort:**\n- Toll-free numbers (separate process — see toll-free help)\n- International numbers\n- Numbers that have been disconnected\n- Some VoIP numbers from smaller providers\n\nIf a number shows as "Not Portable," contact your carrier to confirm the number is active, then try again.';

  // --- COST ---
  if (q.includes('cost') || q.includes('price') || q.includes('fee') || q.includes('how much') || q.includes('charge'))
    return 'Here\'s what porting costs:\n\n**AutoPort:** Free to use\n\n**Phone system charges:** After porting, you\'ll pay standard rates through your phone provider (GHL/LC Phone or Twilio):\n- Local numbers: ~$1.15/month\n- Incoming calls: ~$0.0085/min\n- Outgoing calls: ~$0.014/min\n- SMS: ~$0.0079/message\n\n**Carrier charges:** Your current carrier may charge an early termination fee if you\'re under contract. Check your carrier agreement.\n\n**No porting fee:** There is no fee to port a number.';

  // --- STATUS ---
  if (q.includes('status') || q.includes('where is my port') || q.includes('check progress') || q.includes('track'))
    return 'You can check your port status in several ways:\n\n1. **My Requests tab** — Click "My Requests" in the top nav to see all your ports and their current status\n2. **Email updates** — You receive an email at every status change (LOA ready, submitted to carrier, FOC date, complete, or rejected)\n3. **Refresh button** — On the status page after submitting, click "Refresh Status" to check live\n\n**Status stages:**\n- Waiting for LOA → Sign your LOA email\n- Submitted to Carrier → Carrier is processing\n- FOC Date Confirmed → Your port date is set\n- Complete → Number is live!';

  // --- FOC DATE ---
  if (q.includes('foc') || q.includes('firm order') || q.includes('port date'))
    return 'The **FOC (Firm Order Commitment) date** is the official date your carrier has agreed to complete the port.\n\n- You\'ll receive an email when the FOC date is confirmed\n- This is typically 3-10 business days after your carrier receives the request\n- On the FOC date, your number switches over (usually early morning)\n- **Do NOT cancel your carrier before this date**\n- Make sure your GHL workflows are configured before the FOC date';

  // --- WEBHOOK / POST-PORT ---
  if (q.includes('webhook') || q.includes('after port') || q.includes('configure') || q.includes('workflow') || q.includes('what happens after'))
    return 'After your port completes, here\'s what to do:\n\n1. **SMS downtime** — Wait up to 3 business days for SMS to start working\n2. **Configure in GHL** — Set up phone trees, call routing, and SMS workflows\n3. **A2P 10DLC** — Register for business SMS if you haven\'t already\n4. **Test calls** — Make a test call to verify voice is working\n5. **Cancel old carrier** — You can now safely cancel with your previous carrier\n6. **Update contacts** — Let your clients know they can reach you at the same number\n\nAutoPort can automatically configure GHL webhooks for your ported number if you provide a Location ID.';

  // --- HELP / GENERIC ---
  if (q.includes('help') || q.includes('support') || q.includes('contact') || q.includes('talk to') || q.includes('human'))
    return 'I can help with most porting questions! Here\'s what I cover:\n\n- **Timelines** — How long porting takes\n- **Rejections** — Why ports fail and how to fix them\n- **LOA** — Letter of Authorization explained\n- **Credentials** — Finding your Account SID & Auth Token\n- **Carrier tips** — AT&T, Verizon, T-Mobile specific advice\n- **Bulk porting** — CSV formatting and batch imports\n- **Post-port setup** — SMS, A2P 10DLC, webhooks\n\nIf you need more help, click the **"Contact Support"** button below to generate a pre-filled support ticket with all your details.';

  // No static match — return null to trigger AI
  return null;
}

function getGenericHelp() {
  return 'I\'m the AutoPort porting assistant! I can help with:\n\n- **Porting timelines** — how long it takes\n- **Rejection fixes** — what went wrong and how to fix it\n- **LOA questions** — what it is and how to sign\n- **Finding your credentials** — Account SID and Auth Token\n- **Carrier-specific tips** — AT&T, Verizon, T-Mobile\n- **Toll-free porting** — special requirements\n- **Bulk imports** — CSV formatting\n- **Post-port setup** — A2P 10DLC, SMS, webhooks\n- **Costs** — what porting costs\n\nTry asking something specific, or click a quick button below!';
}

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/generate-loa
//  Generate LOA PDF from form data
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/generate-loa', async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { firstName, lastName, businessName, address, phoneNumbers, loaMode } = req.body;

    if (!firstName || !lastName || !phoneNumbers?.length) {
      return res.status(400).json({ error: 'firstName, lastName, and phoneNumbers required' });
    }

    let loaGroups;
    if (loaMode === 'per-number') {
      loaGroups = phoneNumbers.map(n => [n]);
    } else if (loaMode === 'per-carrier') {
      const byCarrier = {};
      phoneNumbers.forEach(n => {
        const carrier = n.carrier || 'Unknown';
        if (!byCarrier[carrier]) byCarrier[carrier] = [];
        byCarrier[carrier].push(n);
      });
      loaGroups = Object.values(byCarrier);
    } else {
      loaGroups = [phoneNumbers];
    }

    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="LOA-${firstName}-${lastName}-${Date.now()}.pdf"`);
      res.send(pdfBuffer);
    });

    loaGroups.forEach((group, groupIdx) => {
      if (groupIdx > 0) doc.addPage();

      doc.fontSize(20).font('Helvetica-Bold').text('Porting Letter of Authorization (LOA)', { align: 'center' });
      doc.moveDown(1.5);

      doc.fontSize(11).font('Helvetica-Bold').text('1. Customer Name (must appear exactly as it does on your telephone bill):');
      doc.moveDown(0.5);

      doc.rect(50, doc.y, 250, 28).stroke('#999');
      doc.rect(310, doc.y, 252, 28).stroke('#999');
      doc.fontSize(8).font('Helvetica').fillColor('#666')
        .text('First Name', 55, doc.y + 3)
        .text('Last Name', 315, doc.y - 8);
      doc.fontSize(12).font('Helvetica').fillColor('#000')
        .text(firstName, 55, doc.y + 4)
        .text(lastName, 315, doc.y - 16);
      doc.y += 22;
      doc.moveDown(0.5);

      if (businessName) {
        doc.rect(50, doc.y, 512, 28).stroke('#999');
        doc.fontSize(8).fillColor('#666').text('Business Name', 55, doc.y + 3);
        doc.fontSize(12).fillColor('#000').text(businessName, 55, doc.y + 4);
        doc.y += 22;
      }
      doc.moveDown(1);

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
        .text('2. Service Address on file with your current carrier:');
      doc.moveDown(0.5);

      const addr = address || {};
      doc.rect(50, doc.y, 512, 28).stroke('#999');
      doc.fontSize(8).fillColor('#666').text('Address', 55, doc.y + 3);
      doc.fontSize(11).fillColor('#000').text(addr.street || '', 55, doc.y + 4);
      doc.y += 32;

      const addrY = doc.y;
      doc.rect(50, addrY, 200, 28).stroke('#999');
      doc.rect(258, addrY, 150, 28).stroke('#999');
      doc.rect(416, addrY, 146, 28).stroke('#999');
      doc.fontSize(8).fillColor('#666')
        .text('City', 55, addrY + 3)
        .text('State/Province', 263, addrY + 3)
        .text('Zip/Postal Code', 421, addrY + 3);
      doc.fontSize(11).fillColor('#000')
        .text(addr.city || '', 55, addrY + 14)
        .text(addr.state || '', 263, addrY + 14)
        .text(addr.zip || '', 421, addrY + 14);
      doc.y = addrY + 36;
      doc.moveDown(1);

      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
        .text('3. Telephone Number(s) authorized to change to the Company:');
      doc.moveDown(0.5);

      const tblY = doc.y;
      const colWidths = [140, 130, 130, 112];
      const colX = [50, 190, 320, 450];
      const headers = ['Phone Number*', 'Service Provider', 'Account Number', 'PIN (if applicable)'];

      doc.rect(50, tblY, 512, 22).fill('#e5e5e5').stroke('#999');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000');
      headers.forEach((h, i) => doc.text(h, colX[i] + 5, tblY + 6, { width: colWidths[i] - 10 }));

      let rowY = tblY + 22;
      const numbersPerPage = Math.min(group.length, 20);
      for (let j = 0; j < numbersPerPage; j++) {
        if (rowY > 650) { doc.addPage(); rowY = 50; }
        const n = group[j];
        const rowH = 26;
        doc.rect(50, rowY, 512, rowH).stroke('#999');
        doc.fontSize(10).font('Helvetica').fillColor('#000');
        const digits = (n.number || '').replace(/\D/g, '');
        const display = digits.length >= 10 ? `(${digits.slice(-10,-7)}) ${digits.slice(-7,-4)}-${digits.slice(-4)}` : n.number;
        doc.text(display, colX[0] + 5, rowY + 7, { width: colWidths[0] - 10 });
        doc.text(n.carrier || '', colX[1] + 5, rowY + 7, { width: colWidths[1] - 10 });
        doc.text(n.account_number || n.account || '', colX[2] + 5, rowY + 7, { width: colWidths[2] - 10 });
        doc.text(n.pin || '', colX[3] + 5, rowY + 7, { width: colWidths[3] - 10 });
        rowY += rowH;
      }

      if (group.length > 4) {
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#333')
          .text(`*${group.length} total numbers in this LOA`, 50, rowY + 5);
      }

      const authY = Math.max(rowY + 25, doc.y);
      if (authY > 580) { doc.addPage(); doc.y = 50; } else { doc.y = authY; }

      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text('By signing the below, I verify that I am, or represent (for a business), the above-named service customer, authorized to change the primary carrier(s) for the telephone number(s) listed, and am at least 18 years of age. The name and address I have provided is the name and address on record with my local telephone company for each telephone number listed. I authorize Twilio (the "Company") or its designated agent to act on my behalf and notify my current carrier(s) to change my preferred carrier(s) for the listed number(s) and service(s).', {
          width: 512, lineGap: 3
        });
      doc.moveDown(2);

      const sigY = doc.y;
      doc.strokeColor('#333')
        .moveTo(50, sigY).lineTo(220, sigY).stroke()
        .moveTo(240, sigY).lineTo(420, sigY).stroke()
        .moveTo(440, sigY).lineTo(562, sigY).stroke();
      doc.fontSize(8).fillColor('#666')
        .text('Authorized Signature', 50, sigY + 4)
        .text('Print Name', 240, sigY + 4)
        .text('Date', 440, sigY + 4);

      doc.moveDown(2);
      doc.fontSize(8).fillColor('#999')
        .text('For toll free numbers, please change RespOrg to TWI01.', { align: 'center' })
        .text('Please do not end service on the number for 10 days after RespOrg change.', { align: 'center' });
    });

    doc.end();
  } catch (err) {
    console.error('LOA generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Catch-all: serve the porting form ─────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Export for Vercel ──────────────────────────────────────
module.exports = app;

// ── Also listen for local dev ──────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\nAutoPort running at http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Form:   http://localhost:${PORT}/\n`);
  });
}
