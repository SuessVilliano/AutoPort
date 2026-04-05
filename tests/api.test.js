const request = require('supertest');
const app = require('../api/index');

describe('Health Check', () => {
  test('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('autoport-marketplace');
    expect(res.body.version).toBe('2.0.0');
  });
});

describe('Authentication Required', () => {
  test('POST /api/porting/eligibility requires credentials', async () => {
    const res = await request(app)
      .post('/api/porting/eligibility')
      .send({ phoneNumbers: ['+13125889960'] });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/credentials required/i);
  });

  test('POST /api/porting/validate-twilio requires credentials', async () => {
    const res = await request(app)
      .post('/api/porting/validate-twilio')
      .send({});
    expect(res.statusCode).toBe(401);
  });

  test('POST /api/porting/requests requires credentials', async () => {
    const res = await request(app)
      .post('/api/porting/requests')
      .send({});
    expect(res.statusCode).toBe(401);
  });

  test('GET /api/porting/requests/:sid requires credentials', async () => {
    const res = await request(app)
      .get('/api/porting/requests/KW123')
      .set('X-Twilio-Account-SID', '')
      .set('X-Twilio-Auth-Token', '');
    expect(res.statusCode).toBe(401);
  });

  test('POST /api/porting/documents requires credentials', async () => {
    const res = await request(app)
      .post('/api/porting/documents');
    expect(res.statusCode).toBe(401);
  });

  test('POST /api/porting/configure-number requires credentials', async () => {
    const res = await request(app)
      .post('/api/porting/configure-number')
      .send({});
    expect(res.statusCode).toBe(401);
  });
});

describe('Eligibility Validation', () => {
  test('rejects empty phoneNumbers array', async () => {
    const res = await request(app)
      .post('/api/porting/eligibility')
      .set('X-Twilio-Account-SID', 'ACtest123456789012345678901234')
      .set('X-Twilio-Auth-Token', 'test_token')
      .send({ phoneNumbers: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/phoneNumbers/);
  });

  test('rejects missing phoneNumbers', async () => {
    const res = await request(app)
      .post('/api/porting/eligibility')
      .set('X-Twilio-Account-SID', 'ACtest123456789012345678901234')
      .set('X-Twilio-Auth-Token', 'test_token')
      .send({});
    expect(res.statusCode).toBe(400);
  });
});

describe('LOA Generation', () => {
  test('POST /api/porting/generate-loa validates input', async () => {
    const res = await request(app)
      .post('/api/porting/generate-loa')
      .send({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  test('POST /api/porting/generate-loa generates PDF', async () => {
    const res = await request(app)
      .post('/api/porting/generate-loa')
      .send({
        firstName: 'John',
        lastName: 'Smith',
        address: { street: '123 Main St', city: 'Chicago', state: 'IL', zip: '60601' },
        phoneNumbers: [{ number: '+13125889960' }],
        loaMode: 'single',
      });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
  });
});

describe('Webhooks', () => {
  test('POST /api/porting/webhooks/twilio accepts payload', async () => {
    const res = await request(app)
      .post('/api/porting/webhooks/twilio')
      .send({
        port_in_request_sid: 'KWtest123',
        status: 'PortInWaitingForSignature',
        phone_number: '+13125889960',
      });
    expect(res.statusCode).toBe(200);
  });
});

describe('Request List', () => {
  test('GET /api/porting/requests returns array', async () => {
    const res = await request(app).get('/api/porting/requests');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('requests');
    expect(Array.isArray(res.body.requests)).toBe(true);
  });
});

describe('Static Files', () => {
  test('GET / serves the frontend', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('AutoPort');
  });

  test('frontend does NOT contain internal agent references', async () => {
    const res = await request(app).get('/');
    expect(res.text).not.toContain('Internal Agent Tool');
    expect(res.text).not.toContain('migration@leadconnectorhq.com');
    expect(res.text).not.toContain('Smart Paste');
    expect(res.text).not.toContain('BETA');
  });

  test('frontend contains marketplace elements', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('Connect Your Phone Account');
    expect(res.text).toContain('Account SID');
    expect(res.text).toContain('Auth Token');
    expect(res.text).toContain('My Requests');
  });
});

describe('AI Chat Assistant', () => {
  test('POST /api/porting/chat returns helpful response', async () => {
    const res = await request(app)
      .post('/api/porting/chat')
      .send({ message: 'How long does porting take?' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reply).toMatch(/5-15 business days/i);
  });

  test('POST /api/porting/chat handles rejection questions', async () => {
    const res = await request(app)
      .post('/api/porting/chat')
      .send({ message: 'My port was rejected' });
    expect(res.statusCode).toBe(200);
    expect(res.body.reply).toMatch(/mismatch|carrier|fix/i);
  });

  test('POST /api/porting/chat handles credential questions', async () => {
    const res = await request(app)
      .post('/api/porting/chat')
      .send({ message: 'Where do I find my Account SID?' });
    expect(res.statusCode).toBe(200);
    expect(res.body.reply).toMatch(/Account SID/i);
  });

  test('POST /api/porting/chat returns generic help for unknown queries', async () => {
    const res = await request(app)
      .post('/api/porting/chat')
      .send({ message: 'hi' });
    expect(res.statusCode).toBe(200);
    expect(res.body.reply).toMatch(/porting assistant/i);
  });

  test('POST /api/porting/chat rejects empty message', async () => {
    const res = await request(app)
      .post('/api/porting/chat')
      .send({});
    expect(res.statusCode).toBe(400);
  });
});

describe('Removed Endpoints', () => {
  test('POST /api/porting/extract does not exist', async () => {
    const res = await request(app)
      .post('/api/porting/extract')
      .send({ text: 'test ticket' });
    expect(res.headers['content-type']).toMatch(/html/);
  });

  test('GET /beta serves index.html (no beta page)', async () => {
    const res = await request(app).get('/beta');
    expect(res.statusCode).toBe(200);
    expect(res.text).toContain('AutoPort');
    expect(res.text).not.toContain('Agent Testing Sandbox');
  });
});
