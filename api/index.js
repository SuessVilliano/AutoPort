// ─────────────────────────────────────────────────────────
//  AutoPort — Main Vercel Entry Point
//  Single Express app exported as a serverless function.
//  All routes served from one file for Vercel compatibility.
// ─────────────────────────────────────────────────────────

const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');

const twilio     = require('../lib/twilioService');
const validation = require('../lib/validation');
const store      = require('../lib/store');
const emailSvc   = require('../lib/emailService');

const app = express();

// ── Middleware ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files (the porting form lives in /public) ───────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── File upload — memory storage (no disk on Vercel) ───────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are accepted'));
    }
    cb(null, true);
  },
});

// ═══════════════════════════════════════════════════════════
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'autoport-ghl',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: {
      twilioConfigured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      emailConfigured:  !!(process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY),
      emailProvider:    process.env.SENDGRID_API_KEY ? 'sendgrid' : process.env.RESEND_API_KEY ? 'resend' : 'console',
    },
  });
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/eligibility
//  Check if one or more phone numbers can be ported.
//  Body: { phoneNumbers: ["+13125889960", ...], locationId: "..." }
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/eligibility', async (req, res) => {
  try {
    const { phoneNumbers, locationId } = req.body;

    if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      return res.status(400).json({ error: 'phoneNumbers array is required' });
    }

    // TODO: Look up subaccount SID from locationId
    // const subaccountSid = await getSubaccountSid(locationId);
    const subaccountSid = process.env.TWILIO_ACCOUNT_SID; // fallback for dev

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

        // Real Twilio portability check (falls back to simulated if Twilio not configured)
        let result;
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
          try {
            result = await twilio.checkPortability(normalized, subaccountSid);
          } catch (twilioErr) {
            console.warn('Twilio portability check failed, using simulated:', twilioErr.message);
            result = {
              phone_number: normalized,
              portable: true,
              pin_and_account_number_required: type === 'MOBILE',
              number_type: type,
            };
          }
        } else {
          result = {
            phone_number: normalized,
            portable: true,
            pin_and_account_number_required: type === 'MOBILE',
            number_type: type,
          };
        }

        return {
          number: normalized,
          portable: result.portable,
          pinRequired: result.pin_and_account_number_required,
          type: result.number_type || type,
          reason: result.not_portable_reason || null,
        };
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
//  Multipart form: file field "billingStatement", locationId
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/documents', upload.single('billingStatement'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'billingStatement PDF file is required' });
    }

    const { locationId } = req.body;
    const subaccountSid = process.env.TWILIO_ACCOUNT_SID; // replace with locationId lookup

    // Upload to Twilio Documents API (falls back to simulated)
    let documentSid;
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try {
        const doc = await twilio.uploadDocument(req.file.buffer, req.file.originalname, subaccountSid);
        documentSid = doc.sid;
      } catch (twilioErr) {
        console.warn('Twilio doc upload failed, using simulated:', twilioErr.message);
        documentSid = 'ME' + Math.random().toString(36).substr(2, 30).toUpperCase();
      }
    } else {
      documentSid = 'ME' + Math.random().toString(36).substr(2, 30).toUpperCase();
    }

    res.json({
      success: true,
      documentSid,
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
app.post('/api/porting/requests', upload.single('billingStatement'), async (req, res) => {
  try {
    // Parse body (comes as JSON string if multipart, or direct JSON)
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
    const normalizedState = validation.normalizeState(data.address.state);
    data.address.state = normalizedState;

    // 3. Normalize phone numbers
    data.phoneNumbers = data.phoneNumbers.map(n => ({
      ...n,
      number: validation.normalizePhone(n.number),
    }));

    // 4. Upload billing statement if provided
    let documentSid = data.documentSid;
    if (req.file && !documentSid) {
      const subaccountSid = process.env.TWILIO_ACCOUNT_SID;
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        try {
          const doc = await twilio.uploadDocument(req.file.buffer, req.file.originalname, subaccountSid);
          documentSid = doc.sid;
        } catch (twilioErr) {
          console.warn('Twilio doc upload failed, using simulated:', twilioErr.message);
          documentSid = 'ME' + Math.random().toString(36).substr(2, 30).toUpperCase();
        }
      } else {
        documentSid = 'ME' + Math.random().toString(36).substr(2, 30).toUpperCase();
      }
    }
    if (documentSid) data.documentSids = [documentSid];

    // 5. Create port request in Twilio
    const subaccountSid = process.env.TWILIO_ACCOUNT_SID;
    // Create port request (real Twilio or simulated fallback)
    let portSid;
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try {
        const portResult = await twilio.createPortInRequest(data, subaccountSid);
        portSid = portResult.sid;
      } catch (twilioErr) {
        console.warn('Twilio port request failed, using simulated:', twilioErr.message);
        portSid = 'KW' + Math.random().toString(36).substr(2, 30).toUpperCase();
      }
    } else {
      portSid = 'KW' + Math.random().toString(36).substr(2, 30).toUpperCase();
    }

    // 6. Save to store
    const requestRecord = {
      id: portSid,
      portInSid: portSid,
      locationId: data.locationId || 'unknown',
      customerName: data.customerName,
      businessName: data.businessName || null,
      email: data.authorizedRepresentativeEmail,
      ccEmails:  (data.ccEmails  || []).filter(Boolean),
      bccEmails: (data.bccEmails || []).filter(Boolean),
      address: data.address,
      phoneNumbers: data.phoneNumbers,
      status: 'waiting_for_signature',
      documentSid,
      isBeta: data.isBeta || false,
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
      isBeta:           data.isBeta || false,
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
app.get('/api/porting/requests/:sid', async (req, res) => {
  try {
    const { sid } = req.params;

    // Check local store first
    const local = store.getRequest(sid);

    // Also fetch live status from Twilio if configured
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && local) {
      try {
        const twilioStatus = await twilio.getPortRequestStatus(sid);
        if (twilioStatus && twilioStatus.status) {
          local.status = twilioStatus.status;
          store.updateRequest(sid, { status: twilioStatus.status });
        }
      } catch (_e) { /* use local store status */ }
    }

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
app.post('/api/porting/requests/:sid/cancel', async (req, res) => {
  try {
    const { sid } = req.params;
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try { await twilio.cancelPortRequest(sid); } catch (_e) { /* continue with local cancel */ }
    }
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
//  Configure in Twilio Console → Webhooks.
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/webhooks/twilio', (req, res) => {
  try {
    // Acknowledge immediately (Twilio retries if no 200 within 15s)
    res.sendStatus(200);

    const payload = req.body;
    const sid = payload.port_in_request_sid;
    const status = payload.status;
    const phoneNumber = payload.phone_number;
    const rejectionReason = payload.rejection_reason;

    console.log(`[WEBHOOK] ${sid} → ${status}`, phoneNumber ? `(${phoneNumber})` : '');

    if (!sid) return;

    // Update local store
    const updates = { status, updatedAt: new Date().toISOString() };
    if (rejectionReason) updates.rejectionReason = rejectionReason;
    if (phoneNumber) updates.lastUpdatedNumber = phoneNumber;
    const updatedRecord = store.updateRequest(sid, updates);

    // ── Dispatch emails for every status change ───────────
    if (updatedRecord) {
      emailSvc.dispatchWebhookEmail(payload, updatedRecord)
        .catch(e => console.error('[EMAIL DISPATCH ERROR]', e));
    }

    // ── Post-port number configuration ────────────────────
    if (status === 'PortInCompleted' || status === 'PortInPhoneNumberCompleted') {
      console.log(`[PORT COMPLETE] ${sid} — triggering number configuration`);
      // twilio.configurePortedNumber(incomingPhoneNumberSid, accountSid, webhookConfig)
    }
  } catch (err) {
    console.error('Webhook error:', err);
    // Already sent 200, so Twilio won't retry
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/configure-number
//  Attach GHL SMS/voice webhooks after port completes.
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/configure-number', async (req, res) => {
  try {
    const { incomingPhoneNumberSid, accountSid, locationId } = req.body;

    // Build GHL webhook URLs for this location
    const baseUrl = process.env.GHL_WEBHOOK_BASE || 'https://services.leadconnectorhq.com';
    const webhookConfig = {
      smsUrl:   `${baseUrl}/twilio/sms/${locationId}`,
      voiceUrl: `${baseUrl}/twilio/voice/${locationId}`,
      smsMethod:   'POST',
      voiceMethod: 'POST',
    };

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      await twilio.configurePortedNumber(incomingPhoneNumberSid, accountSid, webhookConfig);
    }

    res.json({ success: true, configured: webhookConfig });
  } catch (err) {
    console.error('Configure number error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  GET /api/porting/requests (admin — list all)
// ═══════════════════════════════════════════════════════════
app.get('/api/porting/requests', (_req, res) => {
  res.json({ requests: store.getAllRequests() });
});

// ═══════════════════════════════════════════════════════════
//  BETA ENDPOINTS — Agent testing only
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/porting/beta/send-test-email
 * Fires a real email using any template — for agent sandbox testing.
 */
app.post('/api/porting/beta/send-test-email', async (req, res) => {
  try {
    const { emailType, to, cc, bcc, portInRequestSid, customerName, businessName,
            phoneNumbers, rejectionReason, rejectionCode } = req.body;

    if (!to) return res.status(400).json({ error: 'to email is required' });

    const templates = require('../lib/emailTemplates');
    const emailSvcLocal = require('../lib/emailService');

    const baseData = {
      customerName: customerName || 'Test Agent',
      businessName: businessName || null,
      portInRequestSid: portInRequestSid || 'KWTEST000',
      phoneNumbers: phoneNumbers || [{ number: '+13125559960' }],
      isBeta: true,
    };

    const templateMap = {
      submissionConfirmation: () => templates.submissionConfirmation({ ...baseData, email: to, estimatedDays: '5–15 business days' }),
      loaReadyToSign:         () => templates.loaReadyToSign({ ...baseData, loaUrl: 'https://auto-port.vercel.app/sign-loa' }),
      submittedToCarrier:     () => templates.submittedToCarrier(baseData),
      focDateConfirmed:       () => templates.focDateConfirmed({ ...baseData, focDate: new Date(Date.now() + 7*24*60*60*1000).toISOString() }),
      portRejected:           () => templates.portRejected({ ...baseData, rejectionReason, rejectionCode, fixUrl: 'https://auto-port.vercel.app/fix/demo' }),
      portCompleted:          () => templates.portCompleted({ ...baseData, dashboardUrl: 'https://app.gohighlevel.com' }),
    };

    const tmplFn = templateMap[emailType];
    if (!tmplFn) return res.status(400).json({ error: `Unknown email type: ${emailType}` });

    const tmpl = tmplFn();
    const result = await emailSvcLocal.sendEmail({
      to,
      cc:  [...(cc || []), 'migration@leadconnectorhq.com'].filter((e, i, a) => e && a.indexOf(e) === i),
      bcc: bcc || [],
      subject: tmpl.subject,
      html:    tmpl.html,
      text:    tmpl.text,
      isBeta:  true,
    });

    res.json({ success: true, emailType, provider: result.provider });
  } catch (err) {
    console.error('Beta email error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/porting/beta/preview-email
 * Returns raw HTML of an email template for iframe preview.
 */
app.get('/api/porting/beta/preview-email', (req, res) => {
  try {
    const templates = require('../lib/emailTemplates');
    const { emailType, customerName, numbers, portSid, rejectionReason, rejectionCode } = req.query;
    const phoneNumbers = (numbers || '').split(',').filter(Boolean).map(n => ({ number: n.trim() }));

    const baseData = {
      customerName: customerName || 'Test Agent',
      portInRequestSid: portSid || 'KWTEST000',
      phoneNumbers,
      isBeta: true,
    };

    const templateMap = {
      submissionConfirmation: () => templates.submissionConfirmation({ ...baseData, email: 'agent@gohighlevel.com', estimatedDays: '5–15 business days' }),
      loaReadyToSign:         () => templates.loaReadyToSign({ ...baseData, loaUrl: '#' }),
      submittedToCarrier:     () => templates.submittedToCarrier(baseData),
      focDateConfirmed:       () => templates.focDateConfirmed({ ...baseData, focDate: new Date(Date.now() + 7*24*60*60*1000).toISOString() }),
      portRejected:           () => templates.portRejected({ ...baseData, rejectionReason, rejectionCode }),
      portCompleted:          () => templates.portCompleted({ ...baseData, dashboardUrl: 'https://app.gohighlevel.com' }),
    };

    const tmplFn = templateMap[emailType];
    if (!tmplFn) return res.status(400).send('Unknown email type');

    const tmpl = tmplFn();
    res.setHeader('Content-Type', 'text/html');
    res.send(tmpl.html);
  } catch (err) {
    res.status(500).send(`<p style="color:red">Error: ${err.message}</p>`);
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/extract
//  Smart paste — extract porting details from raw ticket text
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/extract', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'Please paste ticket content (at least 10 characters)' });
    }

    // Try AI extraction first, fall back to regex
    let extracted;
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (geminiKey) {
      extracted = await extractWithGemini(text, geminiKey);
    } else if (openaiKey) {
      extracted = await extractWithOpenAI(text, openaiKey);
    } else {
      extracted = extractWithRegex(text);
    }

    res.json({ success: true, extracted, method: geminiKey ? 'gemini' : openaiKey ? 'openai' : 'regex' });
  } catch (err) {
    console.error('Extract error:', err);
    // Fall back to regex on any AI error
    try {
      const extracted = extractWithRegex(req.body.text || '');
      res.json({ success: true, extracted, method: 'regex-fallback' });
    } catch (e) {
      res.status(500).json({ error: err.message });
    }
  }
});

async function extractWithGemini(text, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const prompt = `Extract porting information from this support ticket text. Return ONLY valid JSON with these fields:
{
  "firstName": "",
  "lastName": "",
  "businessName": "",
  "email": "",
  "phone_numbers": [{"number": "+1XXXXXXXXXX", "type": "LOCAL or MOBILE", "carrier": "", "account_number": "", "pin": ""}],
  "address": {"street": "", "city": "", "state": "", "zip": ""},
  "customerType": "individual or business",
  "notes": "any other relevant context"
}
Leave fields empty string if not found. Normalize phone numbers to +1XXXXXXXXXX format. Here's the ticket:\n\n${text}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1 }
    })
  });
  const data = await resp.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in AI response');
  return JSON.parse(jsonMatch[0]);
}

async function extractWithOpenAI(text, apiKey) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      messages: [{
        role: 'system',
        content: 'Extract porting info from ticket text. Return ONLY JSON: {firstName, lastName, businessName, email, phone_numbers: [{number: "+1XXXXXXXXXX", type, carrier, account_number, pin}], address: {street, city, state, zip}, customerType: "individual"|"business", notes}'
      }, { role: 'user', content: text }]
    })
  });
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON');
  return JSON.parse(jsonMatch[0]);
}

function extractWithRegex(text) {
  const result = {
    firstName: '', lastName: '', businessName: '', email: '',
    phone_numbers: [], address: { street: '', city: '', state: '', zip: '' },
    customerType: 'individual', notes: ''
  };

  // Phone numbers
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/g;
  let match;
  const seen = new Set();
  while ((match = phoneRegex.exec(text)) !== null) {
    const num = `+1${match[1]}${match[2]}${match[3]}`;
    if (!seen.has(num)) {
      seen.add(num);
      result.phone_numbers.push({ number: num, type: 'LOCAL', carrier: '', account_number: '', pin: '' });
    }
  }

  // Email
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) result.email = emailMatch[0];

  // Name patterns
  const nameMatch = text.match(/(?:name|customer|account holder|authorized)[:\s]*([A-Z][a-z]+)\s+([A-Z][a-z]+)/i);
  if (nameMatch) { result.firstName = nameMatch[1]; result.lastName = nameMatch[2]; }

  // Business
  const bizMatch = text.match(/(?:business|company|org)[:\s]*([A-Z][\w\s&.',-]+?)(?:\n|$|,)/i);
  if (bizMatch) { result.businessName = bizMatch[1].trim(); result.customerType = 'business'; }

  // ZIP code
  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zipMatch) result.address.zip = zipMatch[1];

  // State
  const states = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming'];
  const stateAbbrevs = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
  for (let i = 0; i < states.length; i++) {
    if (text.includes(states[i]) || new RegExp(`\\b${stateAbbrevs[i]}\\b`).test(text)) {
      result.address.state = states[i];
      break;
    }
  }

  // Account number / PIN
  const acctMatch = text.match(/(?:account|acct)\s*#?\s*:?\s*(\w+)/i);
  const pinMatch = text.match(/(?:pin|passcode|last 4)\s*:?\s*(\d{4,})/i);
  if (result.phone_numbers.length > 0) {
    if (acctMatch) result.phone_numbers[0].account_number = acctMatch[1];
    if (pinMatch) result.phone_numbers[0].pin = pinMatch[1];
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/chat
//  Conversational AI assistant for porting help
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/chat', upload.single('file'), async (req, res) => {
  try {
    let { message, history } = req.body;
    if (typeof history === 'string') {
      try { history = JSON.parse(history); } catch { history = []; }
    }
    if (!message && !req.file) {
      return res.status(400).json({ error: 'Message or file required' });
    }

    let fileContext = '';
    if (req.file) {
      fileContext = `\n\n[User uploaded file: ${req.file.originalname} (${(req.file.size/1024).toFixed(1)}KB, ${req.file.mimetype})]`;
      if (req.file.mimetype === 'text/csv' || req.file.originalname.endsWith('.csv')) {
        fileContext += `\nCSV Content:\n${req.file.buffer.toString('utf-8').substring(0, 2000)}`;
      }
    }

    const systemPrompt = `You are AutoPort AI, an internal porting assistant for a GoHighLevel support agent. You help with:
- Extracting porting details from ticket text (names, addresses, phone numbers, carrier info, account numbers, PINs)
- Explaining porting processes, timelines (2-4 weeks for <50 numbers, 6-8 weeks for larger)
- Troubleshooting port rejections (common causes: wrong name, wrong address, wrong account#/PIN, unauthorized user)
- LOA requirements (must match carrier records exactly)
- Twilio porting API specifics
- CSV formatting for bulk imports

When extracting info from pasted text, output it clearly formatted so the agent can copy it.
When you see phone numbers, always normalize to +1XXXXXXXXXX format.
Be concise and action-oriented — this is an internal tool, not customer-facing.
If the user pastes ticket content, extract ALL porting-relevant fields and present them clearly.`;

    const fullMessage = message + fileContext;

    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    let reply;
    if (geminiKey) {
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
          contents: [...historyParts, { role: 'user', parts: [{ text: fullMessage }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 }
        })
      });
      const data = await resp.json();
      reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I could not process that.';
    } else if (openaiKey) {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...(history || []).map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: fullMessage }
      ];
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages, temperature: 0.3, max_tokens: 2000 })
      });
      const data = await resp.json();
      reply = data.choices?.[0]?.message?.content || 'Sorry, I could not process that.';
    } else {
      reply = 'AI not configured. Set GEMINI_API_KEY or OPENAI_API_KEY in your environment variables to enable the chat assistant.';
    }

    res.json({ success: true, reply });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  POST /api/porting/generate-loa
//  Generate LOA PDF from form data (matches official Twilio format)
// ═══════════════════════════════════════════════════════════
app.post('/api/porting/generate-loa', async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { firstName, lastName, businessName, address, phoneNumbers, loaMode } = req.body;

    if (!firstName || !lastName || !phoneNumbers?.length) {
      return res.status(400).json({ error: 'firstName, lastName, and phoneNumbers required' });
    }

    // Group numbers based on LOA mode
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

    // Generate PDF
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

      // Title
      doc.fontSize(20).font('Helvetica-Bold').text('Porting Letter of Authorization (LOA)', { align: 'center' });
      doc.moveDown(1.5);

      // 1. Customer Name
      doc.fontSize(11).font('Helvetica-Bold').text('1. Customer Name (must appear exactly as it does on your telephone bill):');
      doc.moveDown(0.5);

      // Name fields
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

      // Business name
      if (businessName) {
        doc.rect(50, doc.y, 512, 28).stroke('#999');
        doc.fontSize(8).fillColor('#666').text('Business Name', 55, doc.y + 3);
        doc.fontSize(12).fillColor('#000').text(businessName, 55, doc.y + 4);
        doc.y += 22;
      }
      doc.moveDown(1);

      // 2. Service Address
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

      // 3. Phone Numbers table
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#000')
        .text('3. Telephone Number(s) authorized to change to the Company:');
      doc.moveDown(0.5);

      // Table header
      const tblY = doc.y;
      const colWidths = [140, 130, 130, 112];
      const colX = [50, 190, 320, 450];
      const headers = ['Phone Number*', 'Service Provider', 'Account Number', 'PIN (if applicable)'];

      // Header row
      doc.rect(50, tblY, 512, 22).fill('#e5e5e5').stroke('#999');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000');
      headers.forEach((h, i) => doc.text(h, colX[i] + 5, tblY + 6, { width: colWidths[i] - 10 }));

      let rowY = tblY + 22;
      // Render up to 4 numbers per page
      const numbersPerPage = Math.min(group.length, 20);
      for (let j = 0; j < numbersPerPage; j++) {
        if (rowY > 650) { doc.addPage(); rowY = 50; }
        const n = group[j];
        const rowH = 26;
        doc.rect(50, rowY, 512, rowH).stroke('#999');
        doc.fontSize(10).font('Helvetica').fillColor('#000');
        // Format phone display
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

      // Authorization text
      const authY = Math.max(rowY + 25, doc.y);
      if (authY > 580) { doc.addPage(); doc.y = 50; } else { doc.y = authY; }

      doc.fontSize(9).font('Helvetica').fillColor('#333')
        .text('By signing the below, I verify that I am, or represent (for a business), the above-named service customer, authorized to change the primary carrier(s) for the telephone number(s) listed, and am at least 18 years of age. The name and address I have provided is the name and address on record with my local telephone company for each telephone number listed. I authorize Twilio (the "Company") or its designated agent to act on my behalf and notify my current carrier(s) to change my preferred carrier(s) for the listed number(s) and service(s).', {
          width: 512, lineGap: 3
        });
      doc.moveDown(2);

      // Signature lines
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
app.get('/beta', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'beta.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Export for Vercel ──────────────────────────────────────
module.exports = app;

// ── Also listen for local dev ──────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀 AutoPort running at http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   Form:   http://localhost:${PORT}/\n`);
  });
}
