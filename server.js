/*
 * ─────────────────────────────────────────────────────────────
 * CardScan — WhatsApp Backend  (server.js)
 *
 * SETUP:
 *   1. cp .env.example .env
 *   2. Paste your NEW WhatsApp token into .env  (revoke the old one first)
 *   3. npm install
 *   4. npm run dev          (development)
 *      npm start            (production)
 *
 * SINGLE ENDPOINT:
 *   POST /api/send-whatsapp
 *   Body: { "to": "919876543210", "name": "John", "company": "Acme" }
 *   Returns: { "success": true, "messageId": "wamid.xxx" }
 *
 * SECURITY:
 *   • Token lives only in .env — never touches the browser
 *   • Rate-limited to 10 requests per minute per IP
 *   • CORS locked to ALLOWED_ORIGIN in .env
 *   • Phone number sanitised server-side before sending
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

// ── Load environment variables from .env ──────────────────────
require('dotenv').config();

const path       = require('path');
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Validate required env vars at startup ─────────────────────
const REQUIRED = ['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('[startup] Missing required environment variables:', missing.join(', '));
  console.error('[startup] Copy .env.example → .env and fill in your credentials.');
  process.exit(1);
}

const WA_TOKEN         = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;
const WA_API_URL       = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN || 'http://localhost:8080';
const allowedOrigins   = ALLOWED_ORIGIN.split(',').map(u => u.trim()).filter(Boolean);

// ── Middleware ────────────────────────────────────────────────

// CORS — only allow requests from trusted frontend origins
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS policy: origin not allowed'));
  },
  methods: ['POST', 'OPTIONS'],
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/worker-local.min.js', express.static(path.join(__dirname, 'worker-local.min.js')));
app.use('/worker.min.js', express.static(path.join(__dirname, 'worker.min.js')));
app.use('/tessdata', express.static(path.join(__dirname, 'tessdata')));
app.use('/node_modules/tesseract.js/dist', express.static(path.join(__dirname, 'node_modules', 'tesseract.js', 'dist')));
app.use('/node_modules/tesseract.js-core', express.static(path.join(__dirname, 'node_modules', 'tesseract.js-core')));

// Parse JSON bodies
app.use(express.json({ limit: '64kb' }));

// Rate limit — max 10 WhatsApp sends per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many requests — try again in a minute.' },
});

// ── Helper: sanitise phone number ─────────────────────────────
/*
 * WhatsApp Cloud API requires E.164 format without the + sign:
 *   "919876543210"  ✓
 *   "+91 98765 43210"  ✗ (strip to digits only)
 *
 * If the number is 10 digits we assume India (+91) as default.
 * Adjust the country-code fallback below for your use case.
 */
function sanitisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;   // ← change country code if needed
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

// ── Helper: build message text ────────────────────────────────
function buildMessage(name, company) {
  const firstName = name ? name.split(' ')[0] : 'there';
  let msg = `Hello ${firstName}, thank you for connecting with us.`;
  if (company) msg += ` We look forward to staying in touch with ${company}.`;
  return msg;
}

// ── POST /api/send-whatsapp ───────────────────────────────────
app.post('/api/send-whatsapp', limiter, async (req, res) => {
  const { to, name, company } = req.body;

  // ── Input validation ────────────────────────────────────────
  if (!to) {
    return res.status(400).json({ success: false, error: 'Missing required field: to (phone number)' });
  }

  const phone = sanitisePhone(to);
  if (!phone) {
    return res.status(400).json({
      success: false,
      error: `Invalid phone number: "${to}". Must be 10–15 digits.`,
    });
  }

  const messageText = buildMessage(name || '', company || '');

  // ── Log request (never log the token) ──────────────────────
  console.log(`[send-whatsapp] to: ${phone} | name: ${name || '—'} | company: ${company || '—'}`);

  // ── Call WhatsApp Cloud API ─────────────────────────────────
  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { body: messageText },
    };


    const response = await axios.post(WA_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,   // token stays server-side
        'Content-Type': 'application/json',
      },



      timeout: 10000,  // 10s timeout
    });

    const messageId = response.data?.messages?.[0]?.id || null;
    console.log(`[send-whatsapp] ✅ Sent — messageId: ${messageId}`);

    return res.json({
      success: true,
      messageId,
      to: phone,
    });

  } catch (err) {
    // ── Decode Meta API errors ───────────────────────────────
    const metaError = err.response?.data?.error;
    const status    = err.response?.status;

    console.error('[send-whatsapp] ❌ Failed');
    console.error('[send-whatsapp] HTTP status :', status);
    console.error('[send-whatsapp] Meta error  :', JSON.stringify(metaError, null, 2));

    let userMessage = 'WhatsApp send failed';
    if (metaError) {
      const code = metaError.code;
      if (code === 190)  userMessage = 'Access token expired or invalid — regenerate it on Meta Developer Console';
      else if (code === 131030) userMessage = 'Recipient phone number not on WhatsApp';
      else if (code === 131031) userMessage = 'WhatsApp Business account not verified';
      else if (code === 131047) userMessage = 'Message failed — recipient may have blocked you';
      else if (code === 131056) userMessage = 'Too many messages sent to this number recently';
      else userMessage = metaError.message || metaError.error_data?.details || 'Unknown Meta API error';
    } else if (err.code === 'ECONNABORTED') {
      userMessage = 'Request timed out — WhatsApp API did not respond';
    } else if (err.code === 'ENOTFOUND') {
      userMessage = 'DNS lookup failed — check server internet connection';
    }

    return res.status(status || 500).json({
      success: false,
      error: userMessage,
      code: metaError?.code,
    });
  }
});

// ── Root route for convenience when browsing the backend directly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cardscan.html'));
});

app.get('/delete', (req, res) => {
    res.sendFile(__dirname + '/public/'data-deletion.html');
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    phoneNumberId: PHONE_NUMBER_ID,
    tokenSet: !!WA_TOKEN,
  });
});

// ── 404 catch-all ─────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[startup] CardScan WhatsApp backend running on port ${PORT}`);
  console.log(`[startup] Accepting requests from: ${ALLOWED_ORIGIN}`);
  console.log(`[startup] Phone Number ID: ${PHONE_NUMBER_ID}`);
  console.log(`[startup] Token loaded: ${WA_TOKEN ? 'YES (' + WA_TOKEN.slice(0,6) + '...)' : 'NO — check .env'}`);
});
