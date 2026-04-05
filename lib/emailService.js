// ─────────────────────────────────────────────────────────
//  Email Service — Marketplace version
//  No hardcoded internal CC. Notification recipients
//  are provided per-request by the user.
// ─────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const templates = require('./emailTemplates');

const FROM_NAME     = 'AutoPort';
const FROM_EMAIL    = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const SENDGRID_KEY  = process.env.SENDGRID_API_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;

// ─────────────────────────────────────────────────────────
//  Core send function
// ─────────────────────────────────────────────────────────
async function sendEmail({ to, cc = [], bcc = [], subject, html, text }) {
  const allCc = cc.filter((e, i, a) => e && a.indexOf(e) === i);

  if (SENDGRID_KEY) return sendViaSendGrid({ to, cc: allCc, bcc, subject, html, text });
  if (RESEND_KEY)   return sendViaResend({ to, cc: allCc, bcc, subject, html, text });

  // Dev fallback: log to console
  console.log('\n[EMAIL - NO PROVIDER CONFIGURED]');
  console.log('   To:      ', to);
  if (allCc.length) console.log('   CC:      ', allCc.join(', '));
  if (bcc.length)   console.log('   BCC:     ', bcc.join(', '));
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
  const toArr = Array.isArray(to) ? to : [to];
  const ccArr = Array.isArray(cc) ? cc.filter(Boolean) : (cc ? [cc] : []);
  const bccArr = Array.isArray(bcc) ? bcc.filter(Boolean) : (bcc ? [bcc] : []);

  const payload = {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: toArr,
    ...(ccArr.length ? { cc: ccArr } : {}),
    ...(bccArr.length ? { bcc: bccArr } : {}),
    subject,
    html,
    text,
  };

  let res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errData = await res.json();
    if (res.status === 403 && errData.message && errData.message.includes('verify a domain')) {
      console.warn('Resend free tier: retrying without CC/BCC recipients');
      const retryPayload = { from: payload.from, to: toArr, subject, html, text };
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(retryPayload),
      });
      if (!res.ok) {
        const retryErr = await res.json();
        throw new Error(`Resend error ${res.status}: ${JSON.stringify(retryErr)}`);
      }
      return { success: true, provider: 'resend', note: 'CC/BCC skipped (free tier)' };
    }
    throw new Error(`Resend error ${res.status}: ${JSON.stringify(errData)}`);
  }
  return { success: true, provider: 'resend' };
}

// ─────────────────────────────────────────────────────────
//  HIGH-LEVEL SEND HELPERS
// ─────────────────────────────────────────────────────────

async function sendSubmissionConfirmation(portData) {
  const tmpl = templates.submissionConfirmation(portData);

  await sendEmail({
    to:      portData.email,
    cc:      portData.ccEmails || [],
    bcc:     portData.bccEmails || [],
    subject: tmpl.subject,
    html:    tmpl.html,
    text:    tmpl.text,
  });
}

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
        fixUrl: `${process.env.BASE_URL || ''}/fix/${storedRequest.id}`,
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
      break;
  }

  const sends = [];

  if (tmpl) {
    sends.push(sendEmail({
      to:      baseData.email,
      cc:      baseData.ccEmails,
      bcc:     baseData.bccEmails,
      subject: tmpl.subject,
      html:    tmpl.html,
      text:    tmpl.text,
    }));
  }

  await Promise.allSettled(sends);
}

module.exports = {
  sendEmail,
  sendSubmissionConfirmation,
  dispatchWebhookEmail,
};
