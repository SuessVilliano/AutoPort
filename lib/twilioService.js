// ─────────────────────────────────────────────────────────
//  Twilio Service — All Twilio API interactions
//  Marketplace version: credentials passed per-request
//  from the user's own Twilio account.
// ─────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const FormData = require('form-data');

// Base64 auth header for HTTP Basic Auth
function authHeader(accountSid, authToken) {
  const creds = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  return `Basic ${creds}`;
}

// Generic Twilio API request helper
async function twilioRequest(method, url, credentials, body = null, isFormData = false) {
  const headers = { Authorization: authHeader(credentials.accountSid, credentials.authToken) };

  let fetchBody;
  if (body && isFormData) {
    fetchBody = body;
    Object.assign(headers, body.getHeaders());
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  const res = await fetch(url, { method, headers, body: fetchBody });
  const json = await res.json();

  if (!res.ok) {
    const err = new Error(json.message || `Twilio API error ${res.status}`);
    err.status = res.status;
    err.twilioCode = json.code;
    err.twilioMore = json.more_info;
    throw err;
  }
  return json;
}

// ─────────────────────────────────────────────────────────
//  0. VALIDATE CREDENTIALS
//     Quick check that the Account SID + Auth Token are valid.
// ─────────────────────────────────────────────────────────
async function validateCredentials(credentials) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}.json`;
  return twilioRequest('GET', url, credentials);
}

// ─────────────────────────────────────────────────────────
//  1. PORTABILITY CHECK
// ─────────────────────────────────────────────────────────
async function checkPortability(phoneNumber, credentials, targetAccountSid) {
  const e164 = phoneNumber.replace(/\s/g, '');
  const params = new URLSearchParams({ TargetAccountSid: targetAccountSid || credentials.accountSid });
  const url = `https://numbers.twilio.com/v1/Porting/Portability/PhoneNumber/${encodeURIComponent(e164)}?${params}`;
  return twilioRequest('GET', url, credentials);
}

// ─────────────────────────────────────────────────────────
//  2. UPLOAD DOCUMENT (Billing Statement)
// ─────────────────────────────────────────────────────────
async function uploadDocument(fileBuffer, fileName, credentials, accountSid) {
  const url = `https://content.twilio.com/v1/Documents`;

  const form = new FormData();
  form.append('Content', fileBuffer, {
    filename: fileName || 'billing_statement.pdf',
    contentType: 'application/pdf',
  });
  form.append('FriendlyName', `Billing Statement - ${new Date().toISOString().split('T')[0]}`);

  return twilioRequest('POST', url, credentials, form, true);
}

// ─────────────────────────────────────────────────────────
//  3. CREATE PORT-IN REQUEST
// ─────────────────────────────────────────────────────────
async function createPortInRequest(portData, credentials, targetAccountSid) {
  const url = 'https://numbers.twilio.com/v1/Porting/PortIn';

  const payload = {
    AccountSid: targetAccountSid || credentials.accountSid,
    NotificationEmails: portData.notificationEmails || [],
    losing_carrier_information: {
      customer_type: portData.customerType === 'business' ? 'business' : 'residential',
      customer_name: portData.customerName,
      authorized_representative: portData.authorizedRepresentative,
      authorized_representative_email: portData.authorizedRepresentativeEmail,
      account_number: portData.carrierAccountNumber || '',
      address: {
        customer_name: portData.customerName,
        street: portData.address.street,
        city: portData.address.city,
        state: portData.address.state,
        postal_code: portData.address.zip,
        country: 'US',
      },
    },
    phone_number: portData.phoneNumbers.map(n => ({
      phone_number: n.number,
      ...(n.pin ? { pin: n.pin } : {}),
    })),
  };

  if (portData.documentSids?.length) {
    payload.documents = portData.documentSids;
  }

  return twilioRequest('POST', url, credentials, payload);
}

// ─────────────────────────────────────────────────────────
//  4. GET PORT REQUEST STATUS
// ─────────────────────────────────────────────────────────
async function getPortRequestStatus(portInSid, credentials) {
  const url = `https://numbers.twilio.com/v1/Porting/PortIn/${portInSid}`;
  return twilioRequest('GET', url, credentials);
}

// ─────────────────────────────────────────────────────────
//  5. CANCEL PORT REQUEST
// ─────────────────────────────────────────────────────────
async function cancelPortRequest(portInSid, credentials) {
  const url = `https://numbers.twilio.com/v1/Porting/PortIn/${portInSid}/cancel`;
  return twilioRequest('POST', url, credentials, {});
}

// ─────────────────────────────────────────────────────────
//  6. CONFIGURE PORTED NUMBER (post-port)
// ─────────────────────────────────────────────────────────
async function configurePortedNumber(incomingPhoneNumberSid, credentials, accountSid, webhookConfig) {
  const sid = accountSid || credentials.accountSid;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${incomingPhoneNumberSid}.json`;

  const payload = {};
  if (webhookConfig.smsUrl)   payload.SmsUrl   = webhookConfig.smsUrl;
  if (webhookConfig.voiceUrl) payload.VoiceUrl  = webhookConfig.voiceUrl;
  if (webhookConfig.smsMethod)   payload.SmsMethod   = webhookConfig.smsMethod;
  if (webhookConfig.voiceMethod) payload.VoiceMethod  = webhookConfig.voiceMethod;

  const form = new URLSearchParams(payload);
  const headers = {
    Authorization: authHeader(credentials.accountSid, credentials.authToken),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const res = await fetch(url, { method: 'POST', headers, body: form.toString() });
  return res.json();
}

// ─────────────────────────────────────────────────────────
//  7. VALIDATE TWILIO WEBHOOK SIGNATURE
// ─────────────────────────────────────────────────────────
function validateWebhookSignature(req) {
  const body = req.body;
  return body && (body.port_in_request_sid || body.PortInRequestSid);
}

module.exports = {
  validateCredentials,
  checkPortability,
  uploadDocument,
  createPortInRequest,
  getPortRequestStatus,
  cancelPortRequest,
  configurePortedNumber,
  validateWebhookSignature,
};
