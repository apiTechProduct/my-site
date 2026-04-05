// ============================================================================
// PROPOSAL APPROVAL ENDPOINT
// ============================================================================
// Handles owner review of pending proposals before they reach the visitor.
//
// Routes:
//   GET  /api/approve-proposal?id=xxx     — approval page (HTML)
//   POST /api/approve-proposal             — approve or request changes (JSON)
//     body: { action: 'approve', id }
//     body: { action: 'revise', id, instructions }
// ============================================================================

const nodemailer = require('nodemailer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { getPendingProposal, updatePendingProposal } = require('./_pending-proposals');

// ── Approve: send proposal to visitor ───────────────────────────────────────

async function approveAndSend(proposal) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return { success: false, error: 'GMAIL_USER or GMAIL_APP_PASSWORD not configured' };

  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });

  const mailOptions = {
    from: `Pallavi Sher <${user}>`,
    to: proposal.visitor_email,
    subject: proposal.visitor_subject,
    text: proposal.visitor_body,
  };

  if (proposal.pdf_base64) {
    mailOptions.attachments = [{
      filename: 'proposal.pdf',
      content: Buffer.from(proposal.pdf_base64, 'base64'),
      contentType: 'application/pdf',
    }];
  }

  try {
    const info = await transport.sendMail(mailOptions);
    console.log('Proposal sent to visitor:', info.messageId);
    return { success: true, message_id: info.messageId };
  } catch (err) {
    console.error('Gmail error on approve:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendTelegramConfirmation(proposal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const message = `APPROVED & SENT\n\nProposal for ${proposal.lead_name} — ${proposal.lead_company}\nScore: ${proposal.lead_score}\n\nEmail sent to: ${proposal.visitor_email}`;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });
}

// ── Revise: re-run the agent with new instructions ───────────────────────────

function sanitizeForPdf(text) {
  if (!text) return '';
  return text
    .replace(/₹/g, 'INR ').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ')
    .replace(/[\u2013\u2014\u2015]/g, '-')
    .replace(/[\u2018\u2019\u201A]/g, "'").replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2039\u203A]/g, "'").replace(/[\u00AB\u00BB]/g, '"')
    .replace(/\u2026/g, '...').replace(/[\u00A0\u2002\u2003\u2007\u202F]/g, ' ')
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '-')
    .replace(/\u2713/g, '[x]').replace(/\u2717/g, '[ ]').replace(/\u00D7/g, 'x')
    .replace(/\u2192/g, '->').replace(/\u2190/g, '<-')
    .replace(/\u2264/g, '<=').replace(/\u2265/g, '>=')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

async function renderPdf({ company_name, contact_name, sections }) {
  company_name = sanitizeForPdf(company_name);
  contact_name = sanitizeForPdf(contact_name);
  sections = sections.map(s => ({ heading: sanitizeForPdf(s.heading), body: sanitizeForPdf(s.body) }));

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const brandPrimary = rgb(0.1, 0.35, 0.32);
  const brandAccent = rgb(0.77, 0.44, 0.23);
  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.35, 0.35, 0.35);

  const cover = pdf.addPage([612, 792]);
  cover.drawRectangle({ x: 0, y: 692, width: 612, height: 100, color: brandPrimary });
  cover.drawText('YOUR NAME', { x: 50, y: 732, size: 22, font: fontBold, color: rgb(1, 1, 1) });
  cover.drawText('Your Tagline Here', { x: 50, y: 710, size: 12, font, color: rgb(0.8, 0.8, 0.8) });
  cover.drawText('PROPOSAL', { x: 50, y: 600, size: 36, font: fontBold, color: brandPrimary });
  cover.drawText(`Prepared for ${contact_name}`, { x: 50, y: 565, size: 16, font, color: black });
  cover.drawText(company_name, { x: 50, y: 542, size: 14, font, color: gray });
  cover.drawText(new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }), { x: 50, y: 510, size: 12, font, color: gray });

  let y = 720;
  let page = pdf.addPage([612, 792]);
  const maxWidth = 500;

  function drawLine(text, options) {
    if (y < 60) { page = pdf.addPage([612, 792]); y = 720; }
    page.drawText(text, { x: 50, y, ...options });
    y -= options.lineHeight || 18;
  }

  for (const section of sections) {
    if (y < 120) { page = pdf.addPage([612, 792]); y = 720; }
    page.drawLine({ start: { x: 50, y: y + 20 }, end: { x: 120, y: y + 20 }, thickness: 2, color: brandAccent });
    drawLine(section.heading, { size: 16, font: fontBold, color: brandPrimary, lineHeight: 28 });
    const paragraphs = section.body.split('\n');
    for (const paragraph of paragraphs) {
      if (paragraph.trim() === '') { y -= 10; continue; }
      const words = paragraph.split(' ');
      let line = '';
      for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(testLine, 11) > maxWidth && line) {
          drawLine(line, { size: 11, font, color: black });
          line = word;
        } else { line = testLine; }
      }
      if (line) drawLine(line, { size: 11, font, color: black });
    }
    y -= 20;
  }

  const lastPage = pdf.getPages()[pdf.getPageCount() - 1];
  lastPage.drawText('your@email.com', { x: 50, y: 30, size: 9, font, color: gray });

  const pdfBytes = await pdf.save();
  return Buffer.from(pdfBytes).toString('base64');
}

const REVISION_TOOL = [{
  type: 'function',
  function: {
    name: 'render_proposal_pdf',
    description: 'Renders a revised proposal PDF.',
    parameters: {
      type: 'object',
      properties: {
        company_name: { type: 'string' },
        contact_name: { type: 'string' },
        sections: {
          type: 'array',
          items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } }, required: ['heading', 'body'] },
        },
      },
      required: ['company_name', 'contact_name', 'sections'],
    },
  },
}];

async function runRevisionAgent(proposal, instructions) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');

  const currentSections = Array.isArray(proposal.proposal_sections)
    ? proposal.proposal_sections
    : (proposal.proposal_sections ? JSON.parse(proposal.proposal_sections) : []);

  const messages = [
    {
      role: 'system',
      content: `You are revising a business proposal based on owner feedback. The original intake context and current proposal sections are provided. Apply the revision instructions precisely, then call render_proposal_pdf with the full revised proposal. Keep all sections not affected by the revision intact.`,
    },
    {
      role: 'user',
      content: `ORIGINAL INTAKE CONTEXT:\n${proposal.intake_context}\n\nCURRENT PROPOSAL SECTIONS:\n${JSON.stringify(currentSections, null, 2)}\n\nREVISION INSTRUCTIONS:\n${instructions}\n\nPlease revise the proposal and call render_proposal_pdf with the updated sections.`,
    },
  ];

  let newPdfBase64 = null;
  let newSections = null;

  for (let turn = 1; turn <= 4; turn++) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4.6',
        messages,
        tools: REVISION_TOOL,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) throw new Error(`OpenRouter error: ${response.status}`);

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) break;

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) break;

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.function.name === 'render_proposal_pdf') {
        const args = JSON.parse(toolCall.function.arguments);
        newPdfBase64 = await renderPdf(args);
        newSections = args.sections.map(s => ({
          heading: sanitizeForPdf(s.heading),
          body: sanitizeForPdf(s.body),
        }));

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ success: true }),
        });
      }
    }

    if (newPdfBase64) break;
  }

  return { pdf_base64: newPdfBase64, sections: newSections };
}

// ── Approval page HTML ───────────────────────────────────────────────────────

function buildApprovalPage(proposal, id, message) {
  const sections = Array.isArray(proposal.proposal_sections)
    ? proposal.proposal_sections
    : (proposal.proposal_sections ? JSON.parse(proposal.proposal_sections) : []);

  const scoreColor = { HIGH: '#16a34a', MEDIUM: '#d97706', LOW: '#dc2626' }[proposal.lead_score] || '#6b7280';
  const statusLabel = proposal.status === 'approved' ? 'APPROVED & SENT'
    : proposal.status === 'revised' ? 'REVISED — PENDING'
    : 'PENDING APPROVAL';
  const statusColor = proposal.status === 'approved' ? '#16a34a'
    : proposal.status === 'revised' ? '#d97706'
    : '#7c3aed';

  const sectionsHtml = sections.map(s => `
    <div class="section">
      <h3>${escapeHtml(s.heading)}</h3>
      <p>${escapeHtml(s.body).replace(/\n/g, '<br>')}</p>
    </div>
  `).join('');

  const messageHtml = message ? `<div class="flash ${message.type}">${escapeHtml(message.text)}</div>` : '';

  const actionButtons = proposal.status !== 'approved' ? `
    <div class="actions">
      <div class="action-group">
        <button class="btn-approve" onclick="doApprove('${id}')">Approve &amp; Send to ${escapeHtml(proposal.visitor_email)}</button>
      </div>
      <div class="action-group revise-group">
        <label>Request Changes</label>
        <textarea id="revise-instructions" rows="4" placeholder="Describe what to change — e.g. 'Make the investment section more specific, add a 3-month timeline, soften the tone in the opening paragraph.'"></textarea>
        <button class="btn-revise" onclick="doRevise('${id}')">Regenerate Proposal</button>
      </div>
    </div>
  ` : `<div class="approved-banner">This proposal has been approved and sent.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Proposal Review — ${escapeHtml(proposal.lead_company || 'Unknown')}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; min-height: 100vh; }
    .header { background: #0f172a; color: #f8fafc; padding: 16px 32px; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 16px; font-weight: 600; letter-spacing: 0.05em; opacity: 0.9; }
    .status-badge { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; padding: 4px 12px; border-radius: 9999px; background: ${statusColor}22; color: ${statusColor}; border: 1px solid ${statusColor}55; }
    .container { max-width: 800px; margin: 32px auto; padding: 0 24px 64px; }
    .flash { padding: 12px 16px; border-radius: 8px; margin-bottom: 24px; font-size: 14px; font-weight: 500; }
    .flash.success { background: #dcfce7; color: #15803d; border: 1px solid #86efac; }
    .flash.error { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; }
    .flash.info { background: #dbeafe; color: #1d4ed8; border: 1px solid #93c5fd; }
    .lead-card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; margin-bottom: 24px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
    .lead-field label { display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; color: #94a3b8; text-transform: uppercase; margin-bottom: 4px; }
    .lead-field span { font-size: 15px; font-weight: 500; color: #1e293b; }
    .score { display: inline-block; font-weight: 700; font-size: 14px; color: ${scoreColor}; background: ${scoreColor}15; padding: 2px 10px; border-radius: 4px; }
    .proposal-body { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px; margin-bottom: 24px; }
    .proposal-body h2 { font-size: 14px; font-weight: 600; letter-spacing: 0.06em; color: #94a3b8; text-transform: uppercase; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0; }
    .section { margin-bottom: 28px; }
    .section:last-child { margin-bottom: 0; }
    .section h3 { font-size: 16px; font-weight: 600; color: #1a5c54; margin-bottom: 10px; }
    .section p { font-size: 14px; line-height: 1.7; color: #475569; }
    .actions { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 28px; }
    .action-group { margin-bottom: 24px; }
    .action-group:last-child { margin-bottom: 0; }
    .revise-group { border-top: 1px solid #e2e8f0; padding-top: 24px; }
    .revise-group label { display: block; font-size: 13px; font-weight: 600; color: #475569; margin-bottom: 8px; }
    textarea { width: 100%; padding: 10px 14px; border: 1px solid #cbd5e1; border-radius: 8px; font-family: inherit; font-size: 14px; color: #1e293b; resize: vertical; outline: none; transition: border-color 0.15s; }
    textarea:focus { border-color: #7c3aed; box-shadow: 0 0 0 3px #7c3aed20; }
    .btn-approve { background: #16a34a; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    .btn-approve:hover { background: #15803d; }
    .btn-approve:disabled { background: #86efac; cursor: not-allowed; }
    .btn-revise { background: #7c3aed; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.15s; margin-top: 10px; }
    .btn-revise:hover { background: #6d28d9; }
    .btn-revise:disabled { background: #c4b5fd; cursor: not-allowed; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.4); border-top-color: white; border-radius: 50%; animation: spin 0.6s linear infinite; margin-right: 8px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .approved-banner { background: #dcfce7; color: #15803d; border: 1px solid #86efac; border-radius: 8px; padding: 16px 20px; font-weight: 600; font-size: 15px; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <h1>PROPOSAL REVIEW</h1>
    <span class="status-badge">${statusLabel}</span>
  </div>
  <div class="container">
    ${messageHtml}
    <div class="lead-card">
      <div class="lead-field"><label>Name</label><span>${escapeHtml(proposal.lead_name || '—')}</span></div>
      <div class="lead-field"><label>Company</label><span>${escapeHtml(proposal.lead_company || '—')}</span></div>
      <div class="lead-field"><label>Score</label><span class="score">${escapeHtml(proposal.lead_score || '—')}</span></div>
      <div class="lead-field"><label>Sending to</label><span>${escapeHtml(proposal.visitor_email || '—')}</span></div>
      <div class="lead-field" style="grid-column: 1 / -1"><label>Challenge</label><span>${escapeHtml(proposal.lead_challenge || '—')}</span></div>
    </div>
    <div class="proposal-body">
      <h2>Proposal Content</h2>
      ${sectionsHtml || '<p style="color:#94a3b8">No proposal sections found.</p>'}
    </div>
    ${actionButtons}
  </div>
  <script>
    const baseUrl = window.location.pathname;

    async function doApprove(id) {
      const btn = document.querySelector('.btn-approve');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Sending...';
      try {
        const res = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', id }),
        });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        } else {
          alert('Error: ' + (data.error || 'Unknown error'));
          btn.disabled = false;
          btn.textContent = 'Approve & Send';
        }
      } catch (e) {
        alert('Request failed: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Approve & Send';
      }
    }

    async function doRevise(id) {
      const instructions = document.getElementById('revise-instructions').value.trim();
      if (!instructions) { alert('Please describe what changes you want.'); return; }
      const btn = document.querySelector('.btn-revise');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Regenerating...';
      try {
        const res = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'revise', id, instructions }),
        });
        const data = await res.json();
        if (data.success) {
          window.location.reload();
        } else {
          alert('Error: ' + (data.error || 'Unknown error'));
          btn.disabled = false;
          btn.textContent = 'Regenerate Proposal';
        }
      } catch (e) {
        alert('Request failed: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Regenerate Proposal';
      }
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // ── GET: render approval page ──
  if (req.method === 'GET') {
    const id = req.query?.id;
    if (!id) return res.status(400).send('<h1>Missing proposal ID</h1>');

    const proposal = await getPendingProposal(id);
    if (!proposal) {
      return res.status(404).send('<h1>Proposal not found</h1><p>It may have expired or the link is invalid.</p>');
    }

    res.setHeader('Content-Type', 'text/html');
    return res.send(buildApprovalPage(proposal, id, null));
  }

  // ── POST: approve or revise ──
  if (req.method === 'POST') {
    const { action, id, instructions } = req.body || {};
    if (!action || !id) return res.status(400).json({ error: 'action and id are required' });

    const proposal = await getPendingProposal(id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    if (action === 'approve') {
      if (proposal.status === 'approved') {
        return res.json({ success: true, message: 'Already approved' });
      }

      const result = await approveAndSend(proposal);
      if (!result.success) return res.status(500).json({ error: result.error });

      await updatePendingProposal(id, { status: 'approved' });
      await sendTelegramConfirmation(proposal);

      return res.json({ success: true, email_id: result.email_id });
    }

    if (action === 'revise') {
      if (!instructions) return res.status(400).json({ error: 'instructions required for revise' });

      let revised;
      try {
        revised = await runRevisionAgent(proposal, instructions);
      } catch (err) {
        console.error('Revision agent error:', err);
        return res.status(500).json({ error: `Revision failed: ${err.message}` });
      }

      if (!revised.pdf_base64) {
        return res.status(500).json({ error: 'Revision agent did not produce a PDF' });
      }

      await updatePendingProposal(id, {
        pdf_base64: revised.pdf_base64,
        proposal_sections: revised.sections,
        status: 'revised',
      });

      return res.json({ success: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
