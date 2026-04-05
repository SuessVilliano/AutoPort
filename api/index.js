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

    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    let reply;

    // Try AI providers, fall back to static responses on any failure
    if (geminiKey) {
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
            generationConfig: { temperature: 0.3, maxOutputTokens: 2000 }
          })
        });
        const data = await resp.json();
        const aiReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
        reply = aiReply || null; // null triggers fallback
        if (!aiReply) console.warn('Gemini returned no content:', JSON.stringify(data.error || data).substring(0, 200));
      } catch (e) {
        console.warn('Gemini error, falling back:', e.message);
        reply = null;
      }
    }

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
          body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.3, max_tokens: 2000 })
        });
        const data = await resp.json();
        reply = data.choices?.[0]?.message?.content || null;
      } catch (e) {
        console.warn('OpenAI error, falling back:', e.message);
        reply = null;
      }
    }

    // Always fall back to static responses if AI fails or isn't configured
    if (!reply) {
      reply = getStaticResponse(message);
    }

    res.json({ success: true, reply });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Static fallback responses when no AI API key is configured
function getStaticResponse(message) {
  const q = message.toLowerCase();

  if (q.includes('how long') || q.includes('timeline') || q.includes('how many days'))
    return 'Standard phone number ports typically take **5-15 business days**. Toll-free numbers take 2-4 weeks. The biggest factor is how quickly you sign the LOA and whether your information matches your carrier records exactly.';

  if (q.includes('reject') || q.includes('denied') || q.includes('failed'))
    return 'The most common rejection reasons are:\n\n1. **Name mismatch** — Call your carrier and ask for the exact name on your account (include LLC, Inc, etc.)\n2. **Address mismatch** — Get the exact service address from your carrier\n3. **Wrong account number** — Check your monthly bill or call your carrier\n4. **Wrong PIN** — Call your carrier to confirm or reset your PIN\n\nAfter correcting the info, you can resubmit from the rejection email.';

  if (q.includes('loa') || q.includes('letter of auth'))
    return 'A **Letter of Authorization (LOA)** is a legal document that authorizes the transfer of your phone number. After you submit a port request, you\'ll receive an email from Twilio with a link to sign your LOA digitally. **You have 30 days to sign it** — after that, the request expires. The LOA must match your carrier records exactly.';

  if (q.includes('account sid') || q.includes('auth token') || q.includes('credentials') || q.includes('where do i find'))
    return 'To find your Account SID and Auth Token:\n\n**GoHighLevel / LC Phone users:**\nSettings → Phone Integration → You\'ll see Account SID and Auth Token\n\n**Direct Twilio users:**\nLog in to console.twilio.com — both are on the main dashboard\n\nThe Account SID starts with "AC" and is 34 characters long.';

  if (q.includes('toll') || q.includes('800') || q.includes('888'))
    return 'Toll-free numbers (800, 833, 844, 855, 866, 877, 888) require a **separate manual porting process** through Twilio\'s international porting form. They typically take 2-4 weeks. AutoPort will detect toll-free numbers during the eligibility check and guide you to the correct form.';

  if (q.includes('cancel') || q.includes('keep active'))
    return '**Do NOT cancel your current carrier service** until you receive a "Port Complete" email. If you cancel early, the port will fail and you could lose your number. Keep paying your current carrier until the port is confirmed complete.';

  if (q.includes('sms') || q.includes('text') || q.includes('a2p') || q.includes('10dlc'))
    return 'After porting, SMS may be unavailable for **up to 3 business days** — this is normal. For business SMS, you\'ll need to register for **A2P 10DLC** (Application-to-Person messaging). This is required by carriers for all business text messaging. You can set this up in your GHL account or Twilio console.';

  if (q.includes('bulk') || q.includes('csv') || q.includes('multiple'))
    return 'For bulk porting, you can upload a **CSV file** with your numbers in Step 1. The CSV should have columns: phone_number, contact_name, type, account_number, pin. You can download a template from the eligibility step. All numbers on a single LOA must have the same account holder.';

  return 'I\'m the AutoPort porting assistant! I can help with:\n\n- **Porting timelines** — how long it takes\n- **Rejection fixes** — what went wrong and how to fix it\n- **LOA questions** — what it is and how to sign\n- **Finding your credentials** — Account SID and Auth Token\n- **Toll-free porting** — special requirements\n- **Bulk imports** — CSV formatting\n- **Post-port setup** — A2P 10DLC, SMS, webhooks\n\nWhat would you like help with?';
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
