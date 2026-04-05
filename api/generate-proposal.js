// ============================================================================
// AGENTIC PROPOSAL ENGINE
// ============================================================================
// This serverless function is an AI AGENT — not a script.
// You give Claude tools and a goal. Claude decides what to do.
//
// Flow: Visitor completes intake chat → this function receives the conversation
//       → Claude writes a proposal, renders a PDF, emails it, and alerts you
//       → All autonomously, in 2-3 turns
//
// Tools: 4 core (render PDF, send email, store lead, alert owner)
//
// Works with: Express (local dev via server.js) and Vercel (production)
//
// APPROVAL MODE (APPROVAL_MODE=true in env):
//   Instead of emailing the visitor directly, stores the proposal, emails
//   the owner for review, and sends a Telegram alert with an approval link.
//   The visitor only gets the email after the owner approves via
//   /api/approve-proposal?id=...
// ============================================================================

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { storePendingProposal } = require('./_pending-proposals');

// ── Tool definitions for Claude ─────────────────────────────────────────────
// These are the "hands" Claude can use. Claude decides WHEN and HOW to use them.

const CORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'render_proposal_pdf',
      description: 'Renders a branded proposal PDF. Returns base64-encoded PDF data.',
      parameters: {
        type: 'object',
        properties: {
          company_name: { type: 'string', description: 'The prospect company name' },
          contact_name: { type: 'string', description: 'The prospect contact name' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['heading', 'body'],
            },
            description: 'Proposal sections, each with a heading and body text',
          },
        },
        required: ['company_name', 'contact_name', 'sections'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Sends an email to the prospect with optional PDF attachment.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Email body text (plain text)' },
          attach_pdf: { type: 'boolean', description: 'Whether to attach the proposal PDF' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'alert_owner',
      description: 'Sends a Telegram alert to the owner with lead summary and proposal PDF.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Alert message text including lead score (HIGH/MEDIUM/LOW)' },
        },
        required: ['message'],
      },
    },
  },
];

const STORE_LEAD_TOOL = {
  type: 'function',
  function: {
    name: 'store_lead',
    description: 'Stores the lead in the CRM database. Score the lead HIGH/MEDIUM/LOW using the triage rules in your system prompt before calling this.',
    parameters: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Contact name' },
        company:   { type: 'string', description: 'Company name' },
        email:     { type: 'string', description: 'Contact email' },
        industry:  { type: 'string', description: 'Company industry' },
        challenge: { type: 'string', description: 'Their main challenge (1-2 sentences)' },
        budget:    { type: 'string', description: 'Budget range mentioned' },
        score:     { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Lead score you determined from triage rules' },
        status:    { type: 'string', description: 'Lead status, e.g. proposal_sent' },
      },
      required: ['name', 'company', 'email', 'score', 'status'],
    },
  },
};

function getTools() {
  return [...CORE_TOOLS, STORE_LEAD_TOOL];
}

// ── PDF text sanitizer ──────────────────────────────────────────────────────
// pdf-lib standard fonts only support WinAnsi encoding (basic ASCII).
// AI-generated text WILL contain characters that crash PDF rendering.
// This function MUST run on ALL text before any drawText() call.

function sanitizeForPdf(text) {
  if (!text) return '';
  return text
    // Currency symbols → text equivalents
    .replace(/₹/g, 'INR ')
    .replace(/€/g, 'EUR ')
    .replace(/£/g, 'GBP ')
    // Dashes → hyphen
    .replace(/[\u2013\u2014\u2015]/g, '-')
    // Curly quotes → straight quotes
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2039\u203A]/g, "'")
    .replace(/[\u00AB\u00BB]/g, '"')
    // Ellipsis → three dots
    .replace(/\u2026/g, '...')
    // Special spaces → regular space
    .replace(/[\u00A0\u2002\u2003\u2007\u202F]/g, ' ')
    // Bullets and symbols → ASCII equivalents
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '-')
    .replace(/\u2713/g, '[x]')
    .replace(/\u2717/g, '[ ]')
    .replace(/\u00D7/g, 'x')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    // Catch-all: remove anything outside printable ASCII + newlines/tabs
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

// ── Request-scoped state ────────────────────────────────────────────────────
// Reset at the start of every request handler invocation.
// (Module-level is shared between concurrent requests on the same instance,
//  but Vercel serverless invocations are isolated, so this is safe in prod.)

let proposalPdfBase64 = null;
let pendingProposalId = null;
let capturedLeadData = {};
let capturedProposalSections = [];
let capturedIntakeContext = '';

// ── Tool implementations ────────────────────────────────────────────────────

async function renderProposalPdf({ company_name, contact_name, sections }) {
  // Sanitize ALL text before rendering
  company_name = sanitizeForPdf(company_name);
  contact_name = sanitizeForPdf(contact_name);
  sections = sections.map(s => ({
    heading: sanitizeForPdf(s.heading),
    body: sanitizeForPdf(s.body),
  }));

  // Capture sections for pending proposal storage
  capturedProposalSections = sections;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // [CUSTOMIZE] Brand colors — change these to match your website
  const brandPrimary = rgb(0.1, 0.35, 0.32);   // dark teal
  const brandAccent = rgb(0.77, 0.44, 0.23);    // warm orange
  const black = rgb(0.1, 0.1, 0.1);
  const gray = rgb(0.35, 0.35, 0.35);

  // ── Cover page ──
  const cover = pdf.addPage([612, 792]);
  // Header bar
  cover.drawRectangle({ x: 0, y: 692, width: 612, height: 100, color: brandPrimary });
  // [CUSTOMIZE] Your name and tagline
  cover.drawText('YOUR NAME', {
    x: 50, y: 732, size: 22, font: fontBold, color: rgb(1, 1, 1),
  });
  cover.drawText('Your Tagline Here', {
    x: 50, y: 710, size: 12, font, color: rgb(0.8, 0.8, 0.8),
  });
  // Proposal title
  cover.drawText('PROPOSAL', {
    x: 50, y: 600, size: 36, font: fontBold, color: brandPrimary,
  });
  cover.drawText(`Prepared for ${contact_name}`, {
    x: 50, y: 565, size: 16, font, color: black,
  });
  cover.drawText(company_name, {
    x: 50, y: 542, size: 14, font, color: gray,
  });
  cover.drawText(
    new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }),
    { x: 50, y: 510, size: 12, font, color: gray }
  );

  // ── Content pages ──
  let y = 720;
  let page = pdf.addPage([612, 792]);
  const maxWidth = 500;

  // Helper: draw a line of text, adding a new page if needed
  function drawLine(text, options) {
    if (y < 60) { page = pdf.addPage([612, 792]); y = 720; }
    page.drawText(text, { x: 50, y, ...options });
    y -= options.lineHeight || 18;
  }

  for (const section of sections) {
    if (y < 120) {
      page = pdf.addPage([612, 792]);
      y = 720;
    }

    // Section heading with accent line above
    page.drawLine({
      start: { x: 50, y: y + 20 }, end: { x: 120, y: y + 20 },
      thickness: 2, color: brandAccent,
    });
    drawLine(section.heading, { size: 16, font: fontBold, color: brandPrimary, lineHeight: 28 });

    // Section body — split on newlines first, then word-wrap each paragraph
    const paragraphs = section.body.split('\n');
    for (const paragraph of paragraphs) {
      if (paragraph.trim() === '') {
        y -= 10; // blank line spacing
        continue;
      }
      const words = paragraph.split(' ');
      let line = '';
      for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        const width = font.widthOfTextAtSize(testLine, 11);
        if (width > maxWidth && line) {
          drawLine(line, { size: 11, font, color: black });
          line = word;
        } else {
          line = testLine;
        }
      }
      if (line) {
        drawLine(line, { size: 11, font, color: black });
      }
    }
    y -= 20; // space between sections
  }

  // ── Footer on last page ──
  const lastPage = pdf.getPages()[pdf.getPageCount() - 1];
  // [CUSTOMIZE] Your contact info
  lastPage.drawText('your@email.com', {
    x: 50, y: 30, size: 9, font, color: gray,
  });

  const pdfBytes = await pdf.save();
  proposalPdfBase64 = Buffer.from(pdfBytes).toString('base64');
  return { success: true, pages: pdf.getPageCount(), size_kb: Math.round(pdfBytes.length / 1024) };
}

async function sendEmail({ to, subject, body, attach_pdf }) {
  const approvalMode = process.env.APPROVAL_MODE === 'true';

  if (approvalMode) {
    // In approval mode: redirect to owner, store pending proposal
    const ownerEmail = process.env.OWNER_EMAIL || 'sher.pallavi@gmail.com';
    const approvalUrl = `${process.env.SITE_URL || 'https://my-site-blue-kappa.vercel.app'}/api/approve-proposal?id=${pendingProposalId}`;

    // Store pending proposal so the approval endpoint can access it
    await storePendingProposal(pendingProposalId, {
      visitor_email: to,
      visitor_subject: subject,
      visitor_body: body,
      pdf_base64: proposalPdfBase64,
      lead_name: capturedLeadData.name || '',
      lead_company: capturedLeadData.company || '',
      lead_challenge: capturedLeadData.challenge || '',
      lead_score: capturedLeadData.score || '',
      proposal_sections: capturedProposalSections,
      intake_context: capturedIntakeContext,
    });

    console.log(`Approval mode: stored pending proposal ${pendingProposalId}, emailing owner`);

    // Email the owner for review (not the visitor)
    const ownerSubject = `[REVIEW REQUIRED] Proposal for ${capturedLeadData.company || to}`;
    const ownerBody = `A new proposal is ready for your review.\n\nLead: ${capturedLeadData.name || 'Unknown'} — ${capturedLeadData.company || ''}\nScore: ${capturedLeadData.score || 'TBD'}\nChallenge: ${capturedLeadData.challenge || ''}\n\nApproval link: ${approvalUrl}\n\nThe proposal PDF is attached.`;

    const result = await sendEmailViaGmail(ownerEmail, ownerSubject, ownerBody, true);
    return { ...result, approval_pending: true, proposal_id: pendingProposalId, approval_url: approvalUrl };
  }

  return sendEmailViaGmail(to, subject, body, attach_pdf);
}

function createGmailTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

async function sendEmailViaGmail(to, subject, body, attach_pdf) {
  const user = process.env.GMAIL_USER;
  const transport = createGmailTransport();
  if (!transport) return { success: false, error: 'GMAIL_USER or GMAIL_APP_PASSWORD not configured' };

  const mailOptions = {
    from: `Pallavi Sher <${user}>`,
    to,
    subject,
    text: body,
  };

  if (attach_pdf && proposalPdfBase64) {
    mailOptions.attachments = [{
      filename: 'proposal.pdf',
      content: Buffer.from(proposalPdfBase64, 'base64'),
      contentType: 'application/pdf',
    }];
  }

  try {
    const info = await transport.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
    return { success: true, message_id: info.messageId };
  } catch (err) {
    console.error('Gmail error:', err.message);
    return { success: false, error: err.message };
  }
}

async function storeLead(leadData) {
  // Capture lead data for pending proposal storage (used by sendEmail in approval mode)
  capturedLeadData = {
    name: leadData.name,
    company: leadData.company,
    email: leadData.email,
    challenge: leadData.challenge,
    score: leadData.score,
  };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return { success: false, error: 'Supabase not configured' };

  // Fields match the leads table schema:
  // name, company, email, industry, challenge, budget, score, status
  // conversation_transcript and created_at are handled separately
  const row = {
    name: leadData.name || null,
    company: leadData.company || null,
    email: leadData.email || null,
    industry: leadData.industry || null,
    challenge: leadData.challenge || null,
    budget: leadData.budget || null,
    score: leadData.score || null,
    status: leadData.status || 'proposal_sent',
  };

  const res = await fetch(`${url}/rest/v1/leads`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', err);
    return { success: false, error: `Supabase error: ${res.status}` };
  }

  return { success: true };
}

async function alertOwner({ message }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return { success: false, error: 'Telegram not configured' };

  const approvalMode = process.env.APPROVAL_MODE === 'true';

  // In approval mode, inject approval link into the message if not already present
  let finalMessage = message;
  if (approvalMode && pendingProposalId) {
    const approvalUrl = `${process.env.SITE_URL || 'https://my-site-blue-kappa.vercel.app'}/api/approve-proposal?id=${pendingProposalId}`;
    if (!finalMessage.includes(approvalUrl)) {
      finalMessage = `${finalMessage}\n\nApprove or request changes: ${approvalUrl}`;
    }
  }

  // Send text alert
  const textRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: finalMessage }),
  });

  if (!textRes.ok) {
    const err = await textRes.text();
    console.error('Telegram error:', err);
    return { success: false, error: `Telegram error: ${textRes.status}` };
  }

  // Send proposal PDF if available
  if (proposalPdfBase64) {
    const pdfBuffer = Buffer.from(proposalPdfBase64, 'base64');
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([pdfBuffer], { type: 'application/pdf' }), 'proposal.pdf');
    formData.append('caption', approvalMode ? 'PENDING APPROVAL — Proposal PDF' : 'Proposal PDF attached');

    await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
  }

  return { success: true };
}

// ── Tool dispatcher ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {
    case 'render_proposal_pdf': return renderProposalPdf(args);
    case 'send_email':          return sendEmail(args);
    case 'store_lead':          return storeLead(args);
    case 'alert_owner':         return alertOwner(args);
    default:                    return { error: `Unknown tool: ${name}` };
  }
}

// ── Agent system prompt ─────────────────────────────────────────────────────
// [CUSTOMIZE] Claude will replace everything below with YOUR identity, voice,
// services, and triage rules from your CLAUDE.md.

function buildSystemPrompt(approvalMode, proposalId) {
  const basePrompt = `You are an AI agent acting on behalf of [YOUR NAME].

You have received intake data from a website visitor. Your job:
1. Write a personalized proposal in [YOUR NAME]'s voice
2. Score the lead using the triage rules below
3. Use your tools to: render the proposal as a PDF, email it to the visitor, store the lead (if store_lead tool is available), and alert [YOUR NAME] on Telegram

## YOUR IDENTITY & VOICE
[Claude will fill this from your CLAUDE.md]

## YOUR SERVICES
[Claude will fill this from your CLAUDE.md "What I Offer" section]

## LEAD TRIAGE RULES
[Claude will fill this from your CLAUDE.md "Chief of Staff Operating Manual"]

## PROPOSAL STRUCTURE
Write 4-5 sections:
1. Understanding Your Challenge — show you listened to their specific situation
2. Recommended Approach — what you would do (specific to their problem)
3. Proposed Engagement — which service, scope, timeline
4. Investment — pricing range based on scope
5. Next Steps — what happens after they review

## INSTRUCTIONS
- Write the proposal in YOUR voice — direct, personal, specific to their situation
- Score the lead using the triage rules (HIGH/MEDIUM/LOW)
- Call render_proposal_pdf with the proposal sections
- If the store_lead tool is available, call it with all lead data and score
- You decide the order. You can call multiple tools at once if they are independent.`;

  if (!approvalMode) {
    return basePrompt + `
- Call send_email with a warm, short email and the PDF attached (send to the visitor)
- Call alert_owner with a summary: company, contact, challenge, score, and one line on why`;
  }

  const siteUrl = process.env.SITE_URL || 'https://my-site-blue-kappa.vercel.app';
  const approvalUrl = `${siteUrl}/api/approve-proposal?id=${proposalId}`;
  const ownerEmail = process.env.OWNER_EMAIL || 'sher.pallavi@gmail.com';

  return basePrompt + `
- Call send_email with to="${ownerEmail}", subject starting with "[REVIEW REQUIRED]", a brief review note, and attach_pdf: true
  DO NOT send to the visitor — the owner must approve first
- Call alert_owner with a message that:
  - Starts with "PENDING APPROVAL"
  - Includes the lead name, company, challenge, and score
  - Includes this approval link: ${approvalUrl}
  - Example format: "PENDING APPROVAL\\n\\nLead: [Name] — [Company]\\nScore: HIGH\\nChallenge: [1 sentence]\\n\\nApprove or request changes: ${approvalUrl}"

## APPROVAL MODE — ACTIVE
This proposal will NOT go to the visitor until you (the owner) review and approve it at the link above.`;
}

// ── Main handler ────────────────────────────────────────────────────────────
// Works as both Express route (local dev) and Vercel serverless function

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { conversation, intakeData, messages: bodyMessages, intake_data } = req.body;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });

  const resolvedIntake = intakeData || intake_data;
  const resolvedConversation = conversation || bodyMessages;

  if (!resolvedConversation && !resolvedIntake) {
    return res.status(400).json({ error: 'conversation or intakeData required' });
  }

  // Reset request-scoped state
  proposalPdfBase64 = null;
  capturedLeadData = {};
  capturedProposalSections = [];

  const approvalMode = process.env.APPROVAL_MODE === 'true';
  pendingProposalId = approvalMode ? crypto.randomBytes(16).toString('hex') : null;

  // Build context from intake data or conversation transcript
  const intakeContext = resolvedIntake
    ? `VISITOR INTAKE DATA:\n${JSON.stringify(resolvedIntake, null, 2)}`
    : `CONVERSATION TRANSCRIPT:\n${resolvedConversation.map(m => `${m.role}: ${m.content}`).join('\n')}`;

  capturedIntakeContext = intakeContext;

  // Build tools list — store_lead only available if Supabase is configured
  const tools = getTools();
  const supabaseReady = !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
  console.log(`Agent starting — approval mode: ${approvalMode}, Supabase: ${supabaseReady ? 'ready' : 'not configured'}`);
  if (approvalMode) console.log(`Pending proposal ID: ${pendingProposalId}`);

  let messages = [
    { role: 'system', content: buildSystemPrompt(approvalMode, pendingProposalId) },
    { role: 'user', content: `${intakeContext}\n\nPlease write a personalized proposal, score this lead, and use your tools to send everything.` },
  ];

  const results = { proposal: false, email: false, stored: false, alerted: false, approval_pending: approvalMode };

  // ── Agent loop — max 5 turns for safety ──
  for (let turn = 1; turn <= 5; turn++) {
    console.log(`Agent turn ${turn}...`);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers?.host ? `https://${req.headers.host}` : 'http://localhost:3000',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4.6',
        messages,
        tools,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Agent OpenRouter error:', err);
      return res.status(502).json({ error: 'Agent API call failed', details: err });
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
      console.error('Agent: no choice in response');
      break;
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // No tool calls = agent is done thinking
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      console.log(`Agent turn ${turn}... Agent completed.`);
      break;
    }

    // Execute each tool call
    const toolNames = assistantMessage.tool_calls.map(tc => tc.function.name);
    console.log(`Agent turn ${turn}... Claude called ${assistantMessage.tool_calls.length} tool(s): ${toolNames.join(', ')}`);

    for (const toolCall of assistantMessage.tool_calls) {
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        console.error(`Failed to parse tool args for ${toolCall.function.name}:`, e.message);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: 'Failed to parse arguments' }),
        });
        continue;
      }

      const result = await executeTool(toolCall.function.name, args);

      // Track what succeeded
      if (toolCall.function.name === 'render_proposal_pdf' && result.success) results.proposal = true;
      if (toolCall.function.name === 'send_email' && result.success) results.email = true;
      if (toolCall.function.name === 'store_lead' && result.success) results.stored = true;
      if (toolCall.function.name === 'alert_owner' && result.success) results.alerted = true;

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.log('Agent pipeline complete:', results);
  return res.json({
    success: true,
    results,
    ...(approvalMode && pendingProposalId ? { proposal_id: pendingProposalId } : {}),
  });
};
