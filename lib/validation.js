// ─────────────────────────────────────────────────────────
//  Validation Utilities
// ─────────────────────────────────────────────────────────

const US_STATES = {
  // Full name → abbreviation  (catches typos submitted via tickets)
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR',
  'california':'CA','colorado':'CO','connecticut':'CT','delaware':'DE',
  'florida':'FL','georgia':'GA','hawaii':'HI','idaho':'ID',
  'illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS',
  'kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
  'north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK',
  'oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT',
  'vermont':'VT','virginia':'VA','washington':'WA','west virginia':'WV',
  'wisconsin':'WI','wyoming':'WY',
  // Common misspellings (add more as you see them in tickets)
  'illonis':'IL','illinios':'IL','califorinia':'CA','californa':'CA',
  'tennesse':'TN','missisippi':'MS','massachucetts':'MA',
  // Already abbreviations
  'al':'AL','ak':'AK','az':'AZ','ar':'AR','ca':'CA','co':'CO','ct':'CT',
  'de':'DE','fl':'FL','ga':'GA','hi':'HI','id':'ID','il':'IL','in':'IN',
  'ia':'IA','ks':'KS','ky':'KY','la':'LA','me':'ME','md':'MD','ma':'MA',
  'mi':'MI','mn':'MN','ms':'MS','mo':'MO','mt':'MT','ne':'NE','nv':'NV',
  'nh':'NH','nj':'NJ','nm':'NM','ny':'NY','nc':'NC','nd':'ND','oh':'OH',
  'ok':'OK','or':'OR','pa':'PA','ri':'RI','sc':'SC','sd':'SD','tn':'TN',
  'tx':'TX','ut':'UT','vt':'VT','va':'VA','wa':'WA','wv':'WV','wi':'WI','wy':'WY'
};

/**
 * Normalize a state string to 2-letter abbreviation.
 * Returns null if unrecognized.
 */
function normalizeState(state) {
  if (!state) return null;
  const key = state.trim().toLowerCase();
  return US_STATES[key] || null;
}

/**
 * Validate and normalize a phone number to E.164 format.
 * Accepts formats like: +13125889960, (312)588-9960, 3125889960
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  // US number: 10 digits or 11 digits starting with 1
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return null;
}

/**
 * Detect likely number type from the number itself.
 * Returns 'TOLL_FREE', 'LOCAL', or 'MOBILE' (MOBILE = unknown local, needs portability check)
 */
function detectNumberType(e164) {
  if (!e164) return 'UNKNOWN';
  const area = e164.slice(2, 5);
  const tollFreeAreaCodes = ['800','833','844','855','866','877','888'];
  if (tollFreeAreaCodes.includes(area)) return 'TOLL_FREE';
  return 'LOCAL'; // Portability API will determine LOCAL vs MOBILE
}

/**
 * Validate a port request payload.
 * Returns { valid: true } or { valid: false, errors: [...] }
 */
function validatePortRequest(data) {
  const errors = [];

  if (!data.customerName?.trim()) errors.push('Customer name is required');
  if (!data.authorizedRepresentative?.trim()) errors.push('Authorized representative name is required');
  if (!data.authorizedRepresentativeEmail?.trim()) errors.push('Authorized representative email is required');
  if (!['individual','business'].includes(data.customerType)) errors.push('Customer type must be individual or business');

  // Address
  const addr = data.address || {};
  if (!addr.street?.trim()) errors.push('Street address is required');
  if (!addr.city?.trim()) errors.push('City is required');
  if (!addr.zip?.trim()) errors.push('ZIP code is required');

  const normalizedState = normalizeState(addr.state);
  if (!normalizedState) errors.push(`Unrecognized state: "${addr.state}". Please use full state name or 2-letter abbreviation.`);

  // Phone numbers
  if (!Array.isArray(data.phoneNumbers) || data.phoneNumbers.length === 0) {
    errors.push('At least one phone number is required');
  } else {
    const seenNumbers = new Set();
    data.phoneNumbers.forEach((n, i) => {
      const normalized = normalizePhone(n.number);
      if (!normalized) {
        errors.push(`Phone number ${i + 1} is not a valid US number: "${n.number}"`);
        return;
      }
      if (seenNumbers.has(normalized)) {
        errors.push(`Duplicate phone number detected: ${normalized}. Remove it from one section.`);
      }
      seenNumbers.add(normalized);

      const type = detectNumberType(normalized);
      if (type === 'TOLL_FREE') {
        errors.push(`${normalized} is a toll-free number. Toll-free ports require the manual process — contact support.`);
      }
    });
  }

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}

module.exports = { normalizeState, normalizePhone, detectNumberType, validatePortRequest };
