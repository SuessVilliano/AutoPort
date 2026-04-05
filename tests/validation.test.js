const validation = require('../lib/validation');

describe('Phone Number Validation', () => {
  test('normalizePhone formats US numbers to E.164', () => {
    expect(validation.normalizePhone('3125889960')).toBe('+13125889960');
    expect(validation.normalizePhone('13125889960')).toBe('+13125889960');
    expect(validation.normalizePhone('+13125889960')).toBe('+13125889960');
    expect(validation.normalizePhone('(312) 588-9960')).toBe('+13125889960');
    expect(validation.normalizePhone('312-588-9960')).toBe('+13125889960');
  });

  test('normalizePhone returns null for invalid numbers', () => {
    expect(validation.normalizePhone('')).toBeNull();
    expect(validation.normalizePhone('123')).toBeNull();
    expect(validation.normalizePhone('abcdef')).toBeNull();
  });

  test('detectNumberType identifies toll-free numbers', () => {
    expect(validation.detectNumberType('+18001234567')).toBe('TOLL_FREE');
    expect(validation.detectNumberType('+18881234567')).toBe('TOLL_FREE');
    expect(validation.detectNumberType('+18661234567')).toBe('TOLL_FREE');
  });

  test('detectNumberType identifies regular numbers', () => {
    const type = validation.detectNumberType('+13125889960');
    expect(['LOCAL', 'MOBILE', 'LANDLINE']).toContain(type);
  });
});

describe('State Normalization', () => {
  test('normalizeState converts full names to abbreviations', () => {
    expect(validation.normalizeState('Illinois')).toBe('IL');
    expect(validation.normalizeState('California')).toBe('CA');
    expect(validation.normalizeState('New York')).toBe('NY');
  });

  test('normalizeState passes through abbreviations', () => {
    expect(validation.normalizeState('IL')).toBe('IL');
    expect(validation.normalizeState('CA')).toBe('CA');
  });
});

describe('Port Request Validation', () => {
  const validRequest = {
    customerName: 'John Smith',
    authorizedRepresentative: 'John Smith',
    authorizedRepresentativeEmail: 'john@example.com',
    customerType: 'individual',
    address: {
      street: '123 Main St',
      city: 'Chicago',
      state: 'Illinois',
      zip: '60601',
    },
    phoneNumbers: [{ number: '+13125889960' }],
  };

  test('validates a complete request', () => {
    const result = validation.validatePortRequest(validRequest);
    expect(result.valid).toBe(true);
  });

  test('rejects missing customer name', () => {
    const result = validation.validatePortRequest({ ...validRequest, customerName: '' });
    expect(result.valid).toBe(false);
  });

  test('rejects missing phone numbers', () => {
    const result = validation.validatePortRequest({ ...validRequest, phoneNumbers: [] });
    expect(result.valid).toBe(false);
  });

  test('rejects missing address', () => {
    const result = validation.validatePortRequest({ ...validRequest, address: {} });
    expect(result.valid).toBe(false);
  });
});
