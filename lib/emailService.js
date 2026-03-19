// ─────────────────────────────────────────────────────────
//  Email Service
//  Uses SendGrid (recommended — Twilio's own email product)
//  as the sending provider. Swap to Resend by changing
//  sendViaSendGrid → sendViaResend below.
//
//  ALWAYS CCs: migration@leadconnectorhq.com (internal team)
// ─────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const templates = require('./emailTemplates');

const INTERNAL_CC   = 'migration@leadconnectorhq.com';
const FROM_NAME     = 'GoHighLevel AutoPort';
const FROM_EMAIL    = process.env.FROM_EMAIL || 'autoport@mg.gohighlevel.com';
const SENDGRID_KEY  = process.env.SENDGRID_API_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;

// ─────────────────────────────────────────────────────────
//  Core send function — builds recipient list with CC/BCC
// ─────────────────────────────────────────────────────────
async function sendEmail({ to, cc = [], bcc = [], subject, html, text, isBeta = false }) {
  // Always include internal CC (unless already in list)
  const allCc = [INTERNAL_CC, ...cc].filter((e, i, a) => e && a.indexOf(e) === i);

  // In beta mode, redirect all emails to the tester — don't spam clients
  let finalTo   = to;
  let finalCc   = allCc;
  let finalBcc  = bcc;

  if (isBeta) {
    finalTo  = to;  // still send to tester's email (that's the point of beta)
    finalCc  = allCc;
    finalBcc = finalBcc;
    subject  = `[BETA TEST] ${subject}`;
  }

  // Pick provider
  if (SENDGRID_KEY) return sendViaSendGrid({ to: finalTo, cc: finalCc, bcc: finalBcc, subject, html, text });
  if (RESEND_KEY)   return sendViaResend({ to: finalTo, cc: finalCc, bcc: finalBcc, subject, html, text });

  // Dev fallback: log to console
  console.log('\n📧 [EMAIL - NO PROVIDER CONFIGURED]');
  console.log('   To:      ', finalTo);
  console.log('   CC:      ', finalCc.join(', '));
  if (finalBcc.length) console.log('   BCC:     ', finalBcc.join(', '));
  console.log('   Subject: ', subject);
  console.log('   (Set SENDGRID_API_KEY or RESEND_API_KEY in env to send real emails)\n');
  return { success: true, provider: 'console' };
}

// ─────────────────────────────────────────────────────────
//  SendGrid provider
// ─────────────────────────────────────────────────────────
async function sendViaSendGrid({ to, cc, bcc, subject, html, text }) {
  const toArr  = Array.isArray(to)  ? to  : [to];
  const ccArr  = Array.isArray(cc)  ? cc  : (cc  ? [cc]  : []);
  const bccArr = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);

  const payload = {
    personalizations: [{
      to:  toArr.map(e => ({ email: e })),
      ...(ccArr.length  ? { cc:  ccArr.map(e => ({ email: e })) } : {}),
      ...(bccArr.length ? { bcc: bccArr.map(e => ({ email: e })) } : {}),
    }],
    from:     { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    content: [
      { type: 'text/plain', value: text || '' },
      { type: 'text/html',  value: html  || '' },
    ],
  };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SendGrid error ${res.status}: ${err}`);
  }
  return { success: true, provider: 'sendgrid' };
}

// ─────────────────────────────────────────────────────────
//  Resend provider (alternative)
// ─────────────────────────────────────────────────────────
async function sendViaResend({ to, cc, bcc, subject, html, text }) {
  const payload = {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to:   Array.isArray(to)  ? to  : [to],
    cc:   Array.isArray(cc)  ? cc  : (cc  ? [cc]  : undefined),
    bcc:  Array.isArray(bcc) ? bcc : (bcc ? [bcc] : undefined),
    subject,
    html,
    text,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend error ${res.status}: ${JSON.stringify(err)}`);
  }
  return { success: true, provider: 'resend' };
}

// ─────────────────────────────────────────────────────────
//  HIGH-LEVEL SEND HELPERS
//  Each maps a Twilio webhook event to the right template
// ─────────────────────────────────────────────────────────

/**
 * Called when a new port request is submitted via the form.
 * Sends confirmation to client + internal CC.
 */
async function sendSubmissionConfirmation(portData) {
  const tmpl = templates.submissionConfirmation(portData);
  const internal = templates.internalAgentAlert({
    event: 'PortRequestSubmitted',
    ...portData,
    status: 'waiting_for_signature',
  });

  await Promise.all([
    sendEmail({
      to:    portData.email,
      cc:    portData.ccEmails || [],
      bcc:   portData.bccEmails || [],
      subject: tmpl.subject,
      html:    tmpl.html,
      text:    tmpl.text,
      isBeta:  portData.isBeta,
    }),
    sendEmail({
      to:      INTERNAL_CC,
      subject: internal.subject,
      html:    internal.html,
      text:    internal.text,
      isBeta:  portData.isBeta,
    }),
  ]);
}

/**
 * Dispatches the right email based on Twilio webhook event type.
 * Call this from the webhook handler with the raw Twilio payload.
 */
async function dispatchWebhookEmail(twilioPayload, storedRequest) {
  if (!storedRequest) return;

  const { status } = twilioPayload;
  const baseData = {
    customerName:     storedRequest.customerName,
    email:            storedRequest.email,
    ccEmails:         storedRequest.ccEmails || [],
    bccEmails:        storedRequest.bccEmails || [],
    portInRequestSid: storedRequest.portInSid || storedRequest.id,
    phoneNumbers:     storedRequest.phoneNumbers || [],
    isBeta:           storedRequest.isBeta || false,
  };

  let tmpl;
  switch (status) {
    case 'PortInWaitingForSignature':
    case 'PortInPhoneNumberWaitingForSignature':
      tmpl = templates.loaReadyToSign({ ...baseData, loaUrl: twilioPayload.loa_url || '#' });
      break;

    case 'PortInInProgress':
    case 'PortInPhoneNumberSubmitted':
      tmpl = templates.submittedToCarrier(baseData);
      break;

    case 'PortInPhoneNumberPending':
      tmpl = templates.focDateConfirmed({ ...baseData, focDate: twilioPayload.foc_date });
      break;

    case 'PortInPhoneNumberRejected':
      tmpl = templates.portRejected({
        ...baseData,
        rejectionReason: twilioPayload.rejection_reason,
        rejectionCode:   twilioPayload.rejection_reason_code,
        fixUrl: `${process.env.BASE_URL || 'https://autoport.vercel.app'}/fix/${storedRequest.id}`,
      });
      break;

    case 'PortInCompleted':
    case 'PortInPhoneNumberCompleted':
      tmpl = templates.portCompleted({
        ...baseData,
        dashboardUrl: 'https://app.gohighlevel.com',
      });
      break;

    default:
      // Still send internal alert for any unhandled event
      break;
  }

  // Internal alert always fires
  const internalTmpl = templates.internalAgentAlert({
    event:            status,
    ...baseData,
    status:           status,
    rejectionReason:  twilioPayload.rejection_reason,
  });

  const sends = [
    sendEmail({
      to:      INTERNAL_CC,
      subject: internalTmpl.subject,
      html:    internalTmpl.html,
      text:    internalTmpl.text,
      isBeta:  baseData.isBeta,
    }),
  ];

  if (tmpl) {
    sends.push(sendEmail({
      to:      baseData.email,
      cc:      baseData.ccEmails,
      bcc:     baseData.bccEmails,
      subject: tmpl.subject,
      html:    tmpl.html,
      text:    tmpl.text,
      isBeta:  baseData.isBeta,
    }));
  }

  await Promise.allSettled(sends); // allSettled so one failure doesn't block others
}

module.exports = {
  sendEmail,
  sendSubmissionConfirmation,
  dispatchWebhookEmail,
};
