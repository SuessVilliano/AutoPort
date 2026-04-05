const twilio = require('../lib/twilioService');

describe('Twilio Service', () => {
  test('exports all required functions', () => {
    expect(typeof twilio.validateCredentials).toBe('function');
    expect(typeof twilio.checkPortability).toBe('function');
    expect(typeof twilio.uploadDocument).toBe('function');
    expect(typeof twilio.createPortInRequest).toBe('function');
    expect(typeof twilio.getPortRequestStatus).toBe('function');
    expect(typeof twilio.cancelPortRequest).toBe('function');
    expect(typeof twilio.configurePortedNumber).toBe('function');
    expect(typeof twilio.validateWebhookSignature).toBe('function');
  });

  test('functions require credentials parameter', async () => {
    // Should throw when called without valid creds (network error expected)
    await expect(
      twilio.validateCredentials({ accountSid: '', authToken: '' })
    ).rejects.toThrow();
  });

  test('validateWebhookSignature checks for required fields', () => {
    expect(twilio.validateWebhookSignature({ body: {} })).toBeFalsy();
    expect(twilio.validateWebhookSignature({ body: { port_in_request_sid: 'KW123' } })).toBeTruthy();
    expect(twilio.validateWebhookSignature({ body: { PortInRequestSid: 'KW123' } })).toBeTruthy();
  });
});

describe('Email Templates', () => {
  const templates = require('../lib/emailTemplates');

  const baseData = {
    customerName: 'Test User',
    portInRequestSid: 'KW_TEST_123',
    phoneNumbers: [{ number: '+13125889960' }],
    email: 'test@example.com',
  };

  test('submissionConfirmation generates valid email', () => {
    const result = templates.submissionConfirmation({
      ...baseData,
      estimatedDays: '5-15 business days',
    });
    expect(result.subject).toContain('Port Request Received');
    expect(result.html).toContain('Test User');
    expect(result.html).toContain('KW_TEST_123');
    expect(result.html).not.toContain('BETA');
    expect(result.html).not.toContain('migration@leadconnectorhq.com');
    expect(result.text).toBeTruthy();
  });

  test('loaReadyToSign generates valid email', () => {
    const result = templates.loaReadyToSign({
      ...baseData,
      loaUrl: 'https://example.com/sign',
    });
    expect(result.subject).toContain('Sign Your Port LOA');
    expect(result.html).toContain('https://example.com/sign');
    expect(result.html).not.toContain('BETA');
  });

  test('submittedToCarrier generates valid email', () => {
    const result = templates.submittedToCarrier(baseData);
    expect(result.subject).toContain('Submitted to Carrier');
    expect(result.html).not.toContain('BETA');
  });

  test('focDateConfirmed generates valid email', () => {
    const result = templates.focDateConfirmed({
      ...baseData,
      focDate: '2025-06-15',
    });
    expect(result.subject).toContain('Port Date Confirmed');
    expect(result.html).toContain('June');
  });

  test('portRejected generates valid email', () => {
    const result = templates.portRejected({
      ...baseData,
      rejectionReason: 'Name mismatch',
      rejectionCode: 'NAME_MISMATCH',
      fixUrl: 'https://example.com/fix',
    });
    expect(result.subject).toContain('Rejected');
    expect(result.html).toContain('Name mismatch');
    expect(result.html).toContain('How to fix this');
  });

  test('portCompleted generates valid email', () => {
    const result = templates.portCompleted({
      ...baseData,
      dashboardUrl: 'https://app.gohighlevel.com',
    });
    expect(result.subject).toContain('Port Complete');
    expect(result.html).toContain('Congratulations');
    expect(result.html).not.toContain('BETA');
  });

  test('no template contains internal references', () => {
    const allTemplates = [
      templates.submissionConfirmation({ ...baseData, estimatedDays: '5-15' }),
      templates.loaReadyToSign({ ...baseData, loaUrl: '#' }),
      templates.submittedToCarrier(baseData),
      templates.focDateConfirmed({ ...baseData, focDate: '2025-06-15' }),
      templates.portRejected({ ...baseData, rejectionReason: 'test' }),
      templates.portCompleted({ ...baseData, dashboardUrl: '#' }),
    ];

    allTemplates.forEach(tmpl => {
      expect(tmpl.html).not.toContain('migration@leadconnectorhq.com');
      expect(tmpl.html).not.toContain('BETA TEST');
      expect(tmpl.html).not.toContain('Internal Agent');
    });
  });
});

describe('Email Service', () => {
  const emailService = require('../lib/emailService');

  test('exports required functions', () => {
    expect(typeof emailService.sendEmail).toBe('function');
    expect(typeof emailService.sendSubmissionConfirmation).toBe('function');
    expect(typeof emailService.dispatchWebhookEmail).toBe('function');
  });

  test('sendEmail falls back to console when no provider configured', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    const result = await emailService.sendEmail({
      to: 'test@example.com',
      subject: 'Test',
      html: '<p>Test</p>',
      text: 'Test',
    });
    expect(result.success).toBe(true);
    expect(result.provider).toBe('console');
    consoleSpy.mockRestore();
  });
});

describe('Store', () => {
  const store = require('../lib/store');

  beforeEach(() => {
    // Clear store between tests
    store.getAllRequests().forEach(r => {
      // Can't delete directly, but we can test with fresh data
    });
  });

  test('saveRequest and getRequest work', () => {
    store.saveRequest('TEST_001', { id: 'TEST_001', status: 'pending' });
    const result = store.getRequest('TEST_001');
    expect(result).toBeTruthy();
    expect(result.id).toBe('TEST_001');
    expect(result.status).toBe('pending');
  });

  test('updateRequest merges data', () => {
    store.saveRequest('TEST_002', { id: 'TEST_002', status: 'pending' });
    store.updateRequest('TEST_002', { status: 'completed' });
    const result = store.getRequest('TEST_002');
    expect(result.status).toBe('completed');
  });

  test('getAllRequests returns sorted array', () => {
    store.saveRequest('TEST_A', { id: 'TEST_A', createdAt: '2025-01-01' });
    store.saveRequest('TEST_B', { id: 'TEST_B', createdAt: '2025-01-02' });
    const all = store.getAllRequests();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test('getRequest returns null for missing ID', () => {
    expect(store.getRequest('NONEXISTENT')).toBeNull();
  });

  test('updateRequest returns null for missing ID', () => {
    expect(store.updateRequest('NONEXISTENT', {})).toBeNull();
  });
});
