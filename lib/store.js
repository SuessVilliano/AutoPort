// ─────────────────────────────────────────────────────────
//  In-Memory Store (development / prototype)
//
//  ⚠️  PRODUCTION NOTE:
//  Vercel serverless functions are stateless — this in-memory
//  store resets between cold starts. For production, replace
//  with a real database. Recommended options:
//    • PlanetScale (MySQL, free tier, Vercel integration)
//    • Supabase (Postgres, free tier, Vercel integration)
//    • Upstash Redis (key-value, free tier, serverless-friendly)
//
//  To add PlanetScale: npm install @planetscale/database
//  and replace the Map below with DB calls.
// ─────────────────────────────────────────────────────────

const requests = new Map();

function saveRequest(id, data) {
  requests.set(id, { ...data, updatedAt: new Date().toISOString() });
}

function getRequest(id) {
  return requests.get(id) || null;
}

function updateRequest(id, updates) {
  const existing = requests.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  requests.set(id, updated);
  return updated;
}

function getAllRequests() {
  return Array.from(requests.values()).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { saveRequest, getRequest, updateRequest, getAllRequests };
