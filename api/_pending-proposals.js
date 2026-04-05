// ============================================================================
// PENDING PROPOSALS STORE
// ============================================================================
// Shared storage for proposals awaiting owner approval.
//
// Storage strategy:
//   - Supabase if configured (required for Vercel — in-memory doesn't persist
//     across function invocations in production)
//   - In-memory Map as fallback (works for local dev, low-volume single-instance)
//
// Supabase table required (run once in your Supabase SQL editor):
//
//   create table pending_proposals (
//     id text primary key,
//     visitor_email text,
//     visitor_subject text,
//     visitor_body text,
//     pdf_base64 text,
//     lead_name text,
//     lead_company text,
//     lead_challenge text,
//     lead_score text,
//     proposal_sections jsonb,
//     intake_context text,
//     status text default 'pending',
//     created_at timestamptz default now()
//   );
// ============================================================================

const inMemoryStore = new Map();

async function storePendingProposal(id, data) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (url && key) {
    const res = await fetch(`${url}/rest/v1/pending_proposals`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ id, ...data, status: 'pending', created_at: new Date().toISOString() }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Supabase pending_proposals store error:', err);
      // Fall back to memory so the flow doesn't break
      inMemoryStore.set(id, { id, ...data, status: 'pending', created_at: new Date().toISOString() });
    } else {
      // Mirror in memory so same-instance GET requests are fast
      inMemoryStore.set(id, { id, ...data, status: 'pending', created_at: new Date().toISOString() });
    }
  } else {
    console.warn('Supabase not configured — pending proposal stored in memory only (will not persist across Vercel invocations)');
    inMemoryStore.set(id, { id, ...data, status: 'pending', created_at: new Date().toISOString() });
  }
}

async function getPendingProposal(id) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  // Check in-memory first (fast path, same instance)
  if (inMemoryStore.has(id)) {
    return inMemoryStore.get(id);
  }

  if (url && key) {
    const res = await fetch(
      `${url}/rest/v1/pending_proposals?id=eq.${encodeURIComponent(id)}&select=*`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      }
    );
    if (res.ok) {
      const rows = await res.json();
      const row = rows[0] || null;
      if (row) inMemoryStore.set(id, row); // cache locally
      return row;
    }
  }

  return null;
}

async function updatePendingProposal(id, updates) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;

  if (url && key) {
    const res = await fetch(
      `${url}/rest/v1/pending_proposals?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(updates),
      }
    );
    if (!res.ok) {
      console.error('Supabase pending_proposals update error:', await res.text());
    }
  }

  // Always update memory mirror
  if (inMemoryStore.has(id)) {
    inMemoryStore.set(id, { ...inMemoryStore.get(id), ...updates });
  }
}

module.exports = { storePendingProposal, getPendingProposal, updatePendingProposal };
