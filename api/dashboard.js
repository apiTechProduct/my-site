// ============================================================================
// LEADS DASHBOARD
// ============================================================================
// Password-protected report of all leads and pending proposals.
// Access: /api/dashboard?key=YOUR_DASHBOARD_KEY
//
// Add DASHBOARD_KEY to your .env and Vercel env vars.
// ============================================================================

async function fetchLeads() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return [];

  const res = await fetch(
    `${url}/rest/v1/leads?select=*&order=created_at.desc&limit=100`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) return [];
  return res.json();
}

async function fetchPendingProposals() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return [];

  const res = await fetch(
    `${url}/rest/v1/pending_proposals?select=id,lead_name,lead_company,lead_email,lead_score,lead_challenge,status,created_at&order=created_at.desc&limit=50`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) return [];
  return res.json();
}

function esc(str) {
  if (!str) return '—';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function scoreChip(score) {
  const map = {
    HIGH:   { bg: '#dcfce7', color: '#15803d', border: '#86efac' },
    MEDIUM: { bg: '#fff7ed', color: '#c2410c', border: '#fdba74' },
    LOW:    { bg: '#eff6ff', color: '#1d4ed8', border: '#93c5fd' },
  };
  const s = map[score] || { bg: '#f1f5f9', color: '#64748b', border: '#cbd5e1' };
  return `<span style="background:${s.bg};color:${s.color};border:1px solid ${s.border};padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:700;letter-spacing:0.06em">${esc(score) || 'N/A'}</span>`;
}

function statusChip(status) {
  const map = {
    pending:       { bg: '#faf5ff', color: '#7c3aed', border: '#d8b4fe' },
    revised:       { bg: '#fff7ed', color: '#c2410c', border: '#fdba74' },
    approved:      { bg: '#dcfce7', color: '#15803d', border: '#86efac' },
    proposal_sent: { bg: '#eff6ff', color: '#1d4ed8', border: '#93c5fd' },
  };
  const s = map[status] || { bg: '#f1f5f9', color: '#64748b', border: '#cbd5e1' };
  const label = (status || 'unknown').replace(/_/g, ' ').toUpperCase();
  return `<span style="background:${s.bg};color:${s.color};border:1px solid ${s.border};padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:700;letter-spacing:0.06em">${label}</span>`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function buildDashboard(leads, proposals, siteUrl) {
  const total = leads.length;
  const high = leads.filter(l => l.score === 'HIGH').length;
  const medium = leads.filter(l => l.score === 'MEDIUM').length;
  const low = leads.filter(l => l.score === 'LOW').length;
  const pendingCount = proposals.filter(p => p.status === 'pending' || p.status === 'revised').length;
  const approvedCount = proposals.filter(p => p.status === 'approved').length;

  const leadsRows = leads.length ? leads.map(l => `
    <tr>
      <td>${esc(l.name)}</td>
      <td>${esc(l.company)}</td>
      <td style="color:#64748b;font-size:13px">${esc(l.email)}</td>
      <td>${scoreChip(l.score)}</td>
      <td style="color:#64748b;font-size:13px;max-width:260px">${esc(l.challenge)}</td>
      <td>${statusChip(l.status)}</td>
      <td style="color:#94a3b8;font-size:12px;white-space:nowrap">${formatDate(l.created_at)}</td>
    </tr>
  `).join('') : `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:40px">No leads yet.</td></tr>`;

  const proposalCards = proposals.length ? proposals.map(p => {
    const isPending = p.status === 'pending' || p.status === 'revised';
    const approvalUrl = `${siteUrl}/api/approve-proposal?id=${p.id}`;
    return `
    <div style="background:white;border:1px solid ${isPending ? '#d8b4fe' : '#e2e8f0'};border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div>
          <div style="font-weight:700;font-size:15px;color:#0f172a">${esc(p.lead_name)}</div>
          <div style="color:#64748b;font-size:13px;margin-top:2px">${esc(p.lead_company)}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          ${scoreChip(p.lead_score)}
          ${statusChip(p.status)}
        </div>
      </div>
      ${p.lead_challenge ? `<div style="color:#475569;font-size:13px;line-height:1.5">${esc(p.lead_challenge)}</div>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px">
        <div style="color:#94a3b8;font-size:12px">${formatDate(p.created_at)}</div>
        ${isPending
          ? `<a href="${approvalUrl}" style="background:#7c3aed;color:white;text-decoration:none;padding:6px 16px;border-radius:6px;font-size:13px;font-weight:600">Review →</a>`
          : `<span style="color:#15803d;font-size:13px;font-weight:600">✓ Approved & sent</span>`
        }
      </div>
    </div>
  `}).join('') : `<div style="text-align:center;color:#94a3b8;padding:40px">No proposals yet.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Leads Dashboard — The Human Stack</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600;700&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #f8fafc; color: #0f172a; font-family: 'Inter', sans-serif; min-height: 100vh; }
    .topbar { background: white; border-bottom: 1px solid #e2e8f0; padding: 16px 40px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .topbar-left { display: flex; align-items: center; gap: 16px; }
    .logo { font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 600; color: #7c3aed; letter-spacing: 0.05em; }
    .divider { width: 1px; height: 20px; background: #e2e8f0; }
    .page-title { font-size: 14px; color: #94a3b8; letter-spacing: 0.04em; }
    .timestamp { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #94a3b8; }
    .container { max-width: 1200px; margin: 0 auto; padding: 40px 24px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-bottom: 48px; }
    .stat-card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .stat-label { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; color: #94a3b8; text-transform: uppercase; margin-bottom: 8px; }
    .stat-value { font-family: 'JetBrains Mono', monospace; font-size: 32px; font-weight: 600; line-height: 1; }
    .stat-value.total { color: #0f172a; }
    .stat-value.high { color: #15803d; }
    .stat-value.medium { color: #c2410c; }
    .stat-value.low { color: #1d4ed8; }
    .stat-value.pending { color: #7c3aed; }
    .stat-value.approved { color: #15803d; }
    .section { margin-bottom: 48px; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; }
    .section-title { font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; }
    .section-count { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #cbd5e1; }
    .table-wrap { overflow-x: auto; border-radius: 12px; border: 1px solid #e2e8f0; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    table { width: 100%; border-collapse: collapse; background: white; }
    thead { background: #f8fafc; }
    th { text-align: left; padding: 12px 16px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #94a3b8; white-space: nowrap; border-bottom: 1px solid #e2e8f0; }
    td { padding: 14px 16px; font-size: 14px; color: #334155; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f8fafc; }
    .proposals-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
    .refresh { font-family: 'JetBrains Mono', monospace; font-size: 12px; cursor: pointer; background: white; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 12px; color: #64748b; }
    .refresh:hover { border-color: #cbd5e1; color: #334155; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="topbar-left">
      <span class="logo">THE HUMAN STACK</span>
      <div class="divider"></div>
      <span class="page-title">Leads Dashboard</span>
    </div>
    <span class="timestamp">Updated ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
  </div>

  <div class="container">

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Leads</div>
        <div class="stat-value total">${total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">High Score</div>
        <div class="stat-value high">${high}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Medium Score</div>
        <div class="stat-value medium">${medium}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Low Score</div>
        <div class="stat-value low">${low}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Pending Review</div>
        <div class="stat-value pending">${pendingCount}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Sent</div>
        <div class="stat-value approved">${approvedCount}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">Pending Proposals</span>
        <span class="section-count">${proposals.length} total</span>
      </div>
      <div class="proposals-grid">
        ${proposalCards}
      </div>
    </div>

    <div class="section">
      <div class="section-header">
        <span class="section-title">All Leads</span>
        <span class="section-count">${total} total</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Company</th>
              <th>Email</th>
              <th>Score</th>
              <th>Challenge</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>${leadsRows}</tbody>
        </table>
      </div>
    </div>

  </div>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Simple key-based access control
  const dashboardKey = process.env.DASHBOARD_KEY;
  if (dashboardKey) {
    const provided = req.query?.key;
    if (!provided || provided !== dashboardKey) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="Dashboard"');
      return res.status(401).send(`<!DOCTYPE html><html><body style="background:#f8fafc;color:#0f172a;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:48px;margin-bottom:16px">🔒</div><div style="color:#64748b">Access denied. Add ?key=YOUR_DASHBOARD_KEY to the URL.</div></div></body></html>`);
    }
  }

  const siteUrl = process.env.SITE_URL || 'https://my-site-blue-kappa.vercel.app';

  const [leads, proposals] = await Promise.all([fetchLeads(), fetchPendingProposals()]);

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(buildDashboard(leads, proposals, siteUrl));
};
