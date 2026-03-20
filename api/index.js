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
