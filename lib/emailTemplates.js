// ─────────────────────────────────────────────────────────
//  Email Templates — Marketplace version
//  Clean, professional templates without internal branding.
// ─────────────────────────────────────────────────────────

const BRAND = {
  primary:   '#2563eb',
  dark:      '#1e3a5f',
  green:     '#059669',
  yellow:    '#f59e0b',
  red:       '#dc2626',
  logo:      'AutoPort',
  helpUrl:   'https://support.gohighlevel.com',
};

function baseLayout(title, accentColor, iconEmoji, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 16px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

      <!-- HEADER -->
      <tr>
        <td style="background:${accentColor};border-radius:14px 14px 0 0;padding:32px 36px;text-align:center;">
          <div style="font-size:44px;margin-bottom:12px;">${iconEmoji}</div>
          <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px;">${title}</div>
          <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:6px;">${BRAND.logo} · Phone Number Porting</div>
        </td>
      </tr>

      <!-- BODY -->
      <tr>
        <td style="background:#ffffff;padding:36px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
          ${bodyHtml}
        </td>
      </tr>

      <!-- FOOTER -->
      <tr>
        <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:0 0 14px 14px;padding:20px 36px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">
            Questions? Reply to this email for assistance.
          </p>
          <p style="margin:8px 0 0;font-size:11px;color:#d1d5db;">
            &copy; ${new Date().getFullYear()} AutoPort &middot; Automated phone number porting
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function formatPhoneList(phoneNumbers) {
  const nums = (phoneNumbers || []).map(n => n.number || n).filter(Boolean);
  if (nums.length === 0) return '—';
  if (nums.length === 1) return `<code style="font-family:monospace;background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:14px;">${nums[0]}</code>`;
  return nums.map(n => `<div style="margin:3px 0;"><code style="font-family:monospace;background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:13px;">${n}</code></div>`).join('');
}

function formatPhoneSubject(phoneNumbers) {
  const nums = (phoneNumbers || []).map(n => n.number || n).filter(Boolean);
  if (nums.length === 0) return '';
  if (nums.length === 1) return nums[0];
  return `${nums[0]} +${nums.length - 1} more`;
}

function infoRow(label, value) {
  return `
    <tr>
      <td style="padding:8px 12px;font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;width:38%;background:#f9fafb;border-bottom:1px solid #f3f4f6;">${label}</td>
      <td style="padding:8px 12px;font-size:14px;color:#111827;font-weight:500;border-bottom:1px solid #f3f4f6;">${value}</td>
    </tr>`;
}

function detailsTable(rows) {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin:20px 0;">
      ${rows.map(([l, v]) => infoRow(l, v)).join('')}
    </table>`;
}

function ctaButton(text, url, color) {
  color = color || BRAND.primary;
  return `
    <div style="text-align:center;margin:28px 0;">
      <a href="${url}" style="display:inline-block;background:${color};color:#fff;font-size:15px;font-weight:700;padding:14px 32px;border-radius:10px;text-decoration:none;letter-spacing:-0.2px;">${text}</a>
    </div>`;
}

function statusBadge(text, color, bg) {
  return `<span style="display:inline-block;background:${bg};color:${color};font-size:12px;font-weight:700;padding:4px 12px;border-radius:20px;">${text}</span>`;
}

// ═══════════════════════════════════════════════════════
//  1. SUBMISSION CONFIRMATION
// ═══════════════════════════════════════════════════════
function submissionConfirmation(data) {
  const { customerName, portInRequestSid, phoneNumbers, estimatedDays } = data;
  const nums = formatPhoneSubject(phoneNumbers);
  const numsHtml = formatPhoneList(phoneNumbers);

  const body = `
    <p style="font-size:16px;font-weight:700;color:#1e3a5f;margin:0 0 8px;">Hi ${customerName},</p>
    <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px;">
      We've received your phone number port request. Here's what happens next:
    </p>

    ${detailsTable([
      ['Request ID', `<code style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${portInRequestSid}</code>`],
      ['Number(s)', numsHtml || '—'],
      ['Status', statusBadge('Waiting for LOA Signature', '#92400e', '#fffbeb')],
      ['Est. Completion', estimatedDays || '5–15 business days'],
    ])}

    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:18px;margin:20px 0;">
      <p style="margin:0 0 10px;font-size:14px;font-weight:700;color:#1d4ed8;">What to do now:</p>
      <ol style="margin:0;padding-left:20px;font-size:13.5px;color:#1d4ed8;line-height:2.2;">
        <li>Check your email for the <strong>Letter of Authorization (LOA)</strong> from Twilio — sign it right away</li>
        <li>Keep your phone numbers <strong>active with your current carrier</strong> until the port is complete</li>
        <li>Configure your GHL workflows for these numbers while you wait</li>
      </ol>
    </div>

    <p style="font-size:13px;color:#6b7280;line-height:1.7;">
      You'll receive an email update at every step. If you have questions, reply to this email.
    </p>`;

  return {
    subject: `Port Request Received — ${nums}`,
    html: baseLayout('Port Request Received!', BRAND.dark, '✅', body),
    text: `Hi ${customerName}, your port request (${portInRequestSid}) for ${nums} has been received. Check your email to sign the LOA.`,
  };
}

// ═══════════════════════════════════════════════════════
//  2. LOA READY TO SIGN
// ═══════════════════════════════════════════════════════
function loaReadyToSign(data) {
  const { customerName, portInRequestSid, phoneNumbers, loaUrl } = data;
  const nums = formatPhoneSubject(phoneNumbers);
  const numsHtml = formatPhoneList(phoneNumbers);

  const body = `
    <p style="font-size:16px;font-weight:700;color:#1e3a5f;margin:0 0 8px;">Hi ${customerName},</p>
    <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 4px;">
      Your <strong>Letter of Authorization (LOA)</strong> is ready. This document authorizes
      the transfer of your number(s) from your current carrier.
    </p>
    <p style="font-size:14px;color:#dc2626;font-weight:600;margin:0 0 20px;">
      Please sign within 30 days or your request will expire.
    </p>

    ${detailsTable([
      ['Request ID', `<code style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${portInRequestSid}</code>`],
      ['Number(s)', numsHtml || '—'],
      ['Action Required', statusBadge('Signature Needed', '#92400e', '#fffbeb')],
    ])}

    ${ctaButton('Sign Your LOA Now', loaUrl || '#', BRAND.primary)}

    <p style="font-size:13px;color:#6b7280;text-align:center;margin-top:-12px;">
      Button not working? Copy this link: <span style="color:${BRAND.primary};font-family:monospace;font-size:12px;">${loaUrl || '#'}</span>
    </p>

    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px;margin-top:20px;">
      <p style="margin:0;font-size:13px;color:#065f46;line-height:1.7;">
        <strong>After signing:</strong> Your port request will be automatically submitted to your current carrier.
        You'll receive a confirmation email and can track progress at any time.
      </p>
    </div>`;

  return {
    subject: `Action Required: Sign Your Port LOA — ${nums}`,
    html: baseLayout('Sign Your Letter of Authorization', BRAND.primary, '✍️', body),
    text: `Hi ${customerName}, your LOA is ready to sign for ${nums}. Sign here: ${loaUrl}`,
  };
}

// ═══════════════════════════════════════════════════════
//  3. SUBMITTED TO CARRIER
// ═══════════════════════════════════════════════════════
function submittedToCarrier(data) {
  const { customerName, portInRequestSid, phoneNumbers } = data;
  const nums = formatPhoneSubject(phoneNumbers);
  const numsHtml = formatPhoneList(phoneNumbers);

  const body = `
    <p style="font-size:16px;font-weight:700;color:#1e3a5f;margin:0 0 8px;">Good news, ${customerName}!</p>
    <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px;">
      Your LOA has been signed and your port request has been officially submitted to your current carrier.
      The carrier now has <strong>3–10 business days</strong> to process it.
    </p>

    ${detailsTable([
      ['Request ID', `<code style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${portInRequestSid}</code>`],
      ['Number(s)', numsHtml || '—'],
      ['Status', statusBadge('Submitted to Carrier', '#1d4ed8', '#eff6ff')],
      ['Next Step', 'Carrier will confirm a FOC (port) date'],
    ])}

    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px;margin:20px 0;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#065f46;">While you wait:</p>
      <ul style="margin:0;padding-left:20px;font-size:13.5px;color:#065f46;line-height:2.2;">
        <li>Keep your number <strong>active</strong> with your current carrier — do not cancel service yet</li>
        <li>Set up your GHL workflows, phone trees, and SMS campaigns for this number</li>
        <li>We'll email you as soon as the carrier confirms a port date</li>
      </ul>
    </div>`;

  return {
    subject: `Port Submitted to Carrier — ${nums}`,
    html: baseLayout('Submitted to Your Carrier', '#0284c7', '📤', body),
    text: `Hi ${customerName}, your port request (${portInRequestSid}) for ${nums} has been submitted to your carrier.`,
  };
}

// ═══════════════════════════════════════════════════════
//  4. FOC DATE CONFIRMED
// ═══════════════════════════════════════════════════════
function focDateConfirmed(data) {
  const { customerName, portInRequestSid, phoneNumbers, focDate } = data;
  const nums = formatPhoneSubject(phoneNumbers);
  const numsHtml = formatPhoneList(phoneNumbers);
  const displayDate = focDate ? new Date(focDate).toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' }) : 'To be confirmed';

  const body = `
    <p style="font-size:16px;font-weight:700;color:#1e3a5f;margin:0 0 8px;">Great news, ${customerName}!</p>
    <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px;">
      Your carrier has confirmed a <strong>Firm Order Commitment (FOC) date</strong> —
      this is the official date your number will transfer.
    </p>

    <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);border-radius:12px;padding:24px;text-align:center;margin:20px 0;">
      <p style="margin:0 0 6px;font-size:13px;color:rgba(255,255,255,0.75);text-transform:uppercase;letter-spacing:1px;">Your Port Date</p>
      <p style="margin:0;font-size:26px;font-weight:800;color:#fff;">${displayDate}</p>
    </div>

    ${detailsTable([
      ['Request ID', `<code style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${portInRequestSid}</code>`],
      ['Number(s)', numsHtml || '—'],
      ['Status', statusBadge('FOC Date Confirmed', '#065f46', '#d1fae5')],
    ])}

    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:16px;margin:20px 0;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#92400e;">Important before port date:</p>
      <ul style="margin:0;padding-left:20px;font-size:13.5px;color:#92400e;line-height:2.2;">
        <li>Do <strong>NOT</strong> cancel service with your carrier before the port completes</li>
        <li>Make sure your number is configured <strong>before</strong> this date</li>
        <li>Note: SMS may be unavailable for up to 3 business days after porting</li>
      </ul>
    </div>`;

  return {
    subject: `Port Date Confirmed: ${displayDate} — ${nums}`,
    html: baseLayout('FOC Date Confirmed!', BRAND.green, '📅', body),
    text: `Hi ${customerName}, your port for ${nums} is confirmed for ${displayDate}. Do NOT cancel your carrier service before this date.`,
  };
}

// ═══════════════════════════════════════════════════════
//  5. PORT REJECTED
// ═══════════════════════════════════════════════════════
function portRejected(data) {
  const { customerName, portInRequestSid, phoneNumbers, rejectionReason, rejectionCode, fixUrl } = data;
  const nums = formatPhoneSubject(phoneNumbers);
  const numsHtml = formatPhoneList(phoneNumbers);

  const fixes = {
    'NAME_MISMATCH':    'The name on your request doesn\'t match your carrier\'s records. Contact your carrier to confirm the exact name on the account.',
    'ADDRESS_MISMATCH': 'The service address doesn\'t match. Call your carrier and ask for the exact address they have on file.',
    'ACCOUNT_NUMBER':   'The account number was incorrect. Find it on your latest carrier bill or call your carrier.',
    'PIN_INCORRECT':    'The PIN/last 4 of SSN was wrong. Call your carrier to confirm or reset your PIN.',
    'NUMBER_ACTIVE':    'Your number may not be active with the carrier. Ensure service is active and try again.',
  };
  const fixInstruction = rejectionCode ? (fixes[rejectionCode] || rejectionReason) : rejectionReason;

  const body = `
    <p style="font-size:16px;font-weight:700;color:#1e3a5f;margin:0 0 8px;">Hi ${customerName},</p>
    <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px;">
      Unfortunately, your carrier rejected the port request for <strong>${nums}</strong>.
      Don't worry — this is common and fixable. Here's what happened and how to resolve it:
    </p>

    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:18px;margin:20px 0;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#991b1b;">Rejection Reason:</p>
      <p style="margin:0;font-size:14px;color:#7f1d1d;font-weight:500;">${rejectionReason || 'Carrier did not provide a reason'}</p>
      ${rejectionCode ? `<p style="margin:6px 0 0;font-size:12px;color:#b91c1c;">Code: ${rejectionCode}</p>` : ''}
    </div>

    ${fixInstruction ? `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:18px;margin:20px 0;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#1d4ed8;">How to fix this:</p>
      <p style="margin:0;font-size:14px;color:#1e40af;line-height:1.7;">${fixInstruction}</p>
    </div>` : ''}

    ${detailsTable([
      ['Request ID', `<code style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${portInRequestSid}</code>`],
      ['Number(s)', numsHtml || '—'],
      ['Status', statusBadge('Rejected', '#991b1b', '#fef2f2')],
    ])}

    ${ctaButton('Fix & Resubmit', fixUrl || '#', '#dc2626')}`;

  return {
    subject: `Port Request Rejected — Action Required for ${nums}`,
    html: baseLayout('Port Request Rejected', BRAND.red, '❌', body),
    text: `Hi ${customerName}, your port for ${nums} was rejected. Reason: ${rejectionReason}. Log in to fix and resubmit.`,
  };
}

// ═══════════════════════════════════════════════════════
//  6. PORT COMPLETED
// ═══════════════════════════════════════════════════════
function portCompleted(data) {
  const { customerName, portInRequestSid, phoneNumbers, dashboardUrl } = data;
  const nums = formatPhoneSubject(phoneNumbers);
  const numsHtml = formatPhoneList(phoneNumbers);

  const body = `
    <p style="font-size:16px;font-weight:700;color:#1e3a5f;margin:0 0 8px;">Congratulations, ${customerName}!</p>
    <p style="font-size:14px;color:#374151;line-height:1.7;margin:0 0 20px;">
      Your phone number(s) have been successfully ported.
      They're now live and ready to use!
    </p>

    <div style="background:linear-gradient(135deg,#059669,#10b981);border-radius:12px;padding:24px;text-align:center;margin:20px 0;">
      <p style="margin:0 0 6px;font-size:13px;color:rgba(255,255,255,0.75);text-transform:uppercase;letter-spacing:1px;">Successfully Ported</p>
      <p style="margin:0;font-size:20px;font-weight:800;color:#fff;">${nums}</p>
    </div>

    ${detailsTable([
      ['Request ID', `<code style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${portInRequestSid}</code>`],
      ['Status', statusBadge('Port Complete!', '#065f46', '#d1fae5')],
      ['Completed', new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' })],
    ])}

    ${ctaButton('Go to Your Dashboard', dashboardUrl || 'https://app.gohighlevel.com', BRAND.green)}

    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:16px;margin:20px 0;">
      <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#92400e;">Important next steps:</p>
      <ul style="margin:0;padding-left:20px;font-size:13.5px;color:#92400e;line-height:2.2;">
        <li>SMS may be unavailable for <strong>up to 3 business days</strong> — this is normal</li>
        <li>If you haven't already, register for <strong>A2P 10DLC</strong> to send business SMS</li>
        <li>You can now safely cancel service for this number with your old carrier</li>
      </ul>
    </div>`;

  return {
    subject: `Port Complete! Your Number is Live — ${nums}`,
    html: baseLayout('Your Number is Live!', BRAND.green, '🎉', body),
    text: `Hi ${customerName}, your port for ${nums} is complete! Your numbers are now live.`,
  };
}

module.exports = {
  submissionConfirmation,
  loaReadyToSign,
  submittedToCarrier,
  focDateConfirmed,
  portRejected,
  portCompleted,
};
