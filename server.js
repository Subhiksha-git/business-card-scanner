/*
─────────────────────────────────────────────────────────────
CardScan — WhatsApp Backend  (server.js)
─────────────────────────────────────────────────────────────
*/
'use strict';

require('dotenv').config();

const path       = require('path');
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Validate required env vars ───────────────────────────────
const REQUIRED = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('[startup] Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const WA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v25.0";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const WHATSAPP_BUSINESS_PHONE_NUMBER = process.env.WHATSAPP_BUSINESS_PHONE_NUMBER;
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const WHATSAPP_TEMPLATE_LANGUAGE_CODE = process.env.WHATSAPP_TEMPLATE_LANGUAGE_CODE || 'en_US';
const WHATSAPP_CARD_RECEIVED_TEMPLATE_NAME = process.env.WHATSAPP_CARD_RECEIVED_TEMPLATE_NAME || 'cardscan_intro';
const WHATSAPP_BUSINESS_CARD_TEMPLATE_NAME = process.env.WHATSAPP_BUSINESS_CARD_TEMPLATE_NAME || 'cardscan_intro';
const WHATSAPP_SCAN_TEMPLATE_NAME = process.env.WHATSAPP_SCAN_TEMPLATE_NAME || 'cardscan_intro';

const WA_API_URL =
`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN || 'http://localhost:8080';
const allowedOrigins   = ALLOWED_ORIGIN.split(',').map(u => u.trim()).filter(Boolean);

// ── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS policy: origin not allowed'));
  },
  methods: ['POST', 'OPTIONS'],
}));

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use('/worker-local.min.js', express.static(path.join(__dirname, 'worker-local.min.js')));
app.use('/worker.min.js', express.static(path.join(__dirname, 'worker.min.js')));
app.use('/tessdata', express.static(path.join(__dirname, 'tessdata')));
app.use('/node_modules/tesseract.js/dist', express.static(path.join(__dirname, 'node_modules', 'tesseract.js', 'dist')));
app.use('/node_modules/tesseract.js-core', express.static(path.join(__dirname, 'node_modules', 'tesseract.js-core')));
app.use(express.json({ limit: '64kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many requests — try again in a minute.' },
});

// ── Helper: sanitise phone number ─────────────────────────────
function sanitisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;   // default India
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
  console.log(`[send-whatsapp] to: ${phone} | name: ${name || '—'} | company: ${company || '—'}`);

  try {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'template',
      template: {
        name: WHATSAPP_CARD_RECEIVED_TEMPLATE_NAME,
        language: {
          code: "en_US"
        }
      }
    };

    const response = await axios.post(WA_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const messageId = response.data?.messages?.[0]?.id || null;
    console.log(`[send-whatsapp] ✅ Sent — messageId: ${messageId}`);

    return res.json({ success: true, messageId, to: phone });

  } catch (err) {
    const metaError = err.response?.data?.error;
    const status    = err.response?.status;

    console.error('[send-whatsapp] ❌ Failed');
    console.error('[send-whatsapp] HTTP status :', status);
    console.error('[send-whatsapp] Meta error  :', JSON.stringify(metaError, null, 2));

    let userMessage = 'WhatsApp send failed';
    if (metaError) {
      const code = metaError.code;
      if (code === 190)  userMessage = 'Access token expired or invalid — regenerate it';
      else if (code === 131030) userMessage = 'Recipient phone number not on WhatsApp';
      else if (code === 131031) userMessage = 'WhatsApp Business account not verified';
      else if (code === 131047) userMessage = 'Recipient may have blocked you';
      else if (code === 131056) userMessage = 'Too many messages sent to this number recently';
      else userMessage = metaError.message || metaError.error_data?.details || 'Unknown Meta API error';
    } else if (err.code === 'ECONNABORTED') {
      userMessage = 'Request timed out';
    } else if (err.code === 'ENOTFOUND') {
      userMessage = 'DNS lookup failed';
    }

    return res.status(status || 500).json({
      success: false,
      error: userMessage,
      code: metaError?.code,
    });
  }
});

// ── Root route ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cardscan.html'));
});

app.get('/remove', (req, res) => {
    res.sendFile(__dirname + '/public/remove.html');
});


// Meta WhatsApp Webhook Verify
app.get('/webhook', (req, res) => {

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});


app.post('/webhook', (req, res) => {
  console.log("Webhook event:", JSON.stringify(req.body));
  res.sendStatus(200);
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
