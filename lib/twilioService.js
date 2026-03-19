// ─────────────────────────────────────────────────────────
//  Twilio Service — All Twilio API interactions
//  Uses GHL master account credentials.
//  Clients never need to provide Twilio credentials.
// ─────────────────────────────────────────────────────────

const fetch = require('node-fetch');
const FormData = require('form-data');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;

// Base64 auth header for HTTP Basic Auth
function authHeader() {
  const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  return `Basic ${creds}`;
}

// Generic Twilio API request helper
async function twilioRequest(method, url, body = null, isFormData = false) {
  const headers = { Authorization: authHeader() };

  let fetchBody;
  if (body && isFormData) {
    // body is a FormData instance
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
//  1. PORTABILITY CHECK
//     Check if a number can be ported to Twilio.
//     targetAccountSid = the client's Twilio subaccount SID
// ─────────────────────────────────────────────────────────
async function checkPortability(phoneNumber, targetAccountSid) {
  const e164 = phoneNumber.replace(/\s/g, '');
  const params = new URLSearchParams({ TargetAccountSid: targetAccountSid || TWILIO_ACCOUNT_SID });
  const url = `https://numbers.twilio.com/v1/Porting/Portability/PhoneNumber/${encodeURIComponent(e164)}?${params}`;
  return twilioRequest('GET', url);
}

// ─────────────────────────────────────────────────────────
//  2. UPLOAD DOCUMENT (Billing Statement)
//     Must be uploaded before creating a port request.
//     fileBuffer = Buffer of the PDF file
//     fileName   = original file name
//     accountSid = subaccount SID to attach to
// ─────────────────────────────────────────────────────────
async function uploadDocument(fileBuffer, fileName, accountSid) {
  const sid = accountSid || TWILIO_ACCOUNT_SID;
  const url = `https://content.twilio.com/v1/Documents`;

  const form = new FormData();
  form.append('Content', fileBuffer, {
    filename: fileName || 'billing_statement.pdf',
    contentType: 'application/pdf',
  });
  form.append('FriendlyName', `Billing Statement - ${new Date().toISOString().split('T')[0]}`);

  return twilioRequest('POST', url, form, true);
}

// ─────────────────────────────────────────────────────────
//  3. CREATE PORT-IN REQUEST
//     Submits the full port request to Twilio.
// ─────────────────────────────────────────────────────────
async function createPortInRequest(portData, targetAccountSid) {
  const url = 'https://numbers.twilio.com/v1/Porting/PortIn';

  const payload = {
    AccountSid: targetAccountSid || TWILIO_ACCOUNT_SID,
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
        state: portData.address.state,  // 2-letter abbrev, normalized before this call
        postal_code: portData.address.zip,
        country: 'US',
      },
    },
    phone_number: portData.phoneNumbers.map(n => ({
      phone_number: n.number,
      ...(n.pin ? { pin: n.pin } : {}),
    })),
  };

  // Attach document SIDs if provided
  if (portData.documentSids?.length) {
    payload.documents = portData.documentSids;
  }

  return twilioRequest('POST', url, payload);
}

// ─────────────────────────────────────────────────────────
//  4. GET PORT REQUEST STATUS
// ─────────────────────────────────────────────────────────
async function getPortRequestStatus(portInSid) {
  const url = `https://numbers.twilio.com/v1/Porting/PortIn/${portInSid}`;
  return twilioRequest('GET', url);
}

// ─────────────────────────────────────────────────────────
//  5. CANCEL PORT REQUEST
// ─────────────────────────────────────────────────────────
async function cancelPortRequest(portInSid) {
  const url = `https://numbers.twilio.com/v1/Porting/PortIn/${portInSid}/cancel`;
  return twilioRequest('POST', url, {});
}

// ─────────────────────────────────────────────────────────
//  6. CONFIGURE PORTED NUMBER (post-port)
//     After porting completes, attach GHL webhooks.
//     incomingPhoneNumberSid = the SID Twilio assigns after port
// ─────────────────────────────────────────────────────────
async function configurePortedNumber(incomingPhoneNumberSid, accountSid, webhookConfig) {
  const sid = accountSid || TWILIO_ACCOUNT_SID;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${incomingPhoneNumberSid}.json`;

  const payload = {};
  if (webhookConfig.smsUrl)   payload.SmsUrl   = webhookConfig.smsUrl;
  if (webhookConfig.voiceUrl) payload.VoiceUrl  = webhookConfig.voiceUrl;
  if (webhookConfig.smsMethod)   payload.SmsMethod   = webhookConfig.smsMethod;
  if (webhookConfig.voiceMethod) payload.VoiceMethod  = webhookConfig.voiceMethod;

  const form = new URLSearchParams(payload);
  const headers = {
    Authorization: authHeader(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const res = await fetch(url, { method: 'POST', headers, body: form.toString() });
  return res.json();
}

// ─────────────────────────────────────────────────────────
//  7. VALIDATE TWILIO WEBHOOK SIGNATURE
// ─────────────────────────────────────────────────────────
function validateWebhookSignature(req) {
  // In production use twilio.validateRequest() from the Twilio SDK
  // Basic check: ensure required fields are present
  const body = req.body;
  return body && (body.port_in_request_sid || body.PortInRequestSid);
}

module.exports = {
  checkPortability,
  uploadDocument,
  createPortInRequest,
  getPortRequestStatus,
  cancelPortRequest,
  configurePortedNumber,
  validateWebhookSignature,
};
