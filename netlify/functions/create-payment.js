const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeEmailHeader(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

async function sendFormSubmissionEmail({ orderId, name, email, phone, telegram, amount, submittedAt }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('create-payment: RESEND_API_KEY missing — skipping form notification', { orderId });
    return;
  }

  const subjectName = sanitizeEmailHeader(name);
  const n      = escapeHtml(name);
  const e      = escapeHtml(email);
  const p      = escapeHtml(phone);
  const tg     = escapeHtml(telegram);
  const oid    = escapeHtml(orderId);
  const amountRub = (Number(amount) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  const html = `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="margin-top:0;">New form submission</h2>
  <p style="color:#c00;font-weight:bold;">Payment not yet confirmed</p>
  <table style="border-collapse:collapse;width:100%;">
    <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:bold;background:#f5f5f5;width:140px;">Name</td><td style="padding:8px 12px;border:1px solid #ddd;">${n}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:bold;background:#f5f5f5;">Email</td><td style="padding:8px 12px;border:1px solid #ddd;">${e}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:bold;background:#f5f5f5;">Phone</td><td style="padding:8px 12px;border:1px solid #ddd;">${p}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:bold;background:#f5f5f5;">Telegram</td><td style="padding:8px 12px;border:1px solid #ddd;">${tg}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:bold;background:#f5f5f5;">Order ID</td><td style="padding:8px 12px;border:1px solid #ddd;">${oid}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:bold;background:#f5f5f5;">Amount</td><td style="padding:8px 12px;border:1px solid #ddd;">${amountRub} RUB</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:bold;background:#f5f5f5;">Submitted at</td><td style="padding:8px 12px;border:1px solid #ddd;">${submittedAt}</td></tr>
    <tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:bold;background:#f5f5f5;">Status</td><td style="padding:8px 12px;border:1px solid #ddd;color:#c00;font-weight:bold;">Form submitted — payment not confirmed</td></tr>
  </table>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from:    'Philomind AI Team <noreply@philomind-ai.com>',
        to:      'itd.philomind@gmail.com',
        subject: `New form submission — ${subjectName} — payment not confirmed`,
        html,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      console.log('create-payment: form notification sent', { orderId, resendId: data.id });
    } else {
      const errText = await res.text();
      console.error('create-payment: form notification failed', { orderId, status: res.status, body: errText.slice(0, 200) });
    }
  } catch (err) {
    console.error('create-payment: form notification error', { orderId, err: err.message });
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid request body' }),
    };
  }

  const { name, email, phone, telegram } = body;
  if (!name || !email || !phone || !telegram) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required fields' }),
    };
  }

  const terminalKey = process.env.TBANK_TERMINAL_KEY;
  const password    = process.env.TBANK_PASSWORD;

  if (!terminalKey || !password) {
    console.error('Missing TBANK_TERMINAL_KEY or TBANK_PASSWORD env vars');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Payment service not configured' }),
    };
  }

  const siteUrl = process.env.SITE_URL || 'https://philosophy-ai.netlify.app';
  const orderId = `itd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const amount  = 2800000; // 28,000 RUB = 2,800,000 kopecks
  const maskedEmail = email.replace(/^(.{1}).+(@.+)$/, '$1***$2');
  console.log(`create-payment:\nOrderId: ${orderId}\nBuyer: ${maskedEmail}`);

  // T-Bank token: sort all param keys alphabetically (excl. DATA/Receipt/Token),
  // include Password, concatenate values, SHA-256.
  const tokenParams = {
    Amount:          String(amount),
    Description:     'Мышление в эпоху ИИ',
    FailURL:         `${siteUrl}/failed.html?orderId=${orderId}`,
    NotificationURL: `${siteUrl}/.netlify/functions/payment-webhook`,
    OrderId:         orderId,
    Password:        password,
    SuccessURL:      `${siteUrl}/success.html?orderId=${orderId}`,
    TerminalKey:     terminalKey,
  };
  const tokenStr = Object.keys(tokenParams)
    .sort()
    .map(k => tokenParams[k])
    .join('');
  const token = crypto.createHash('sha256').update(tokenStr).digest('hex');

  const payload = {
    TerminalKey:     terminalKey,
    Amount:          amount,
    OrderId:         orderId,
    Description:     'Мышление в эпоху ИИ',
    SuccessURL:      `${siteUrl}/success.html?orderId=${orderId}`,
    FailURL:         `${siteUrl}/failed.html?orderId=${orderId}`,
    NotificationURL: `${siteUrl}/.netlify/functions/payment-webhook`,
    DATA: {
      Name:     name,
      Email:    email,
      Phone:    phone,
      Telegram: telegram,
    },
    Token: token,
  };

  await sendFormSubmissionEmail({
    orderId,
    name,
    email,
    phone,
    telegram,
    amount,
    submittedAt: new Date().toISOString(),
  });

  try {
    const tRes = await fetch('https://securepay.tinkoff.ru/v2/Init', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const result = await tRes.json();

    if (result.Success && result.PaymentURL) {
      // Store buyer data so the webhook can retrieve it later.
      // T-Bank does not echo DATA back in webhook notifications.
      try {
        connectLambda(event);
        const store = getStore('payment-buyers');
        await store.setJSON(orderId, {
          name,
          email,
          phone,
          telegram,
          amount,
          createdAt:      new Date().toISOString(),
          emailStatus:    null,
          emailSendingAt: null,
        }, { ttl: 604800 }); // 7 days
        console.log('create-payment: Blob saved successfully');
      } catch (blobErr) {
        // Blob write failure is non-fatal: log and continue.
        // The webhook will find no blob and skip the email rather than crash.
        console.error('create-payment: blob write failed', { orderId, err: blobErr.message });
        console.log(`create-payment:\nBlob write failed: ${blobErr.message}`);
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentUrl: result.PaymentURL }),
      };
    }

    console.error('T-Bank Init failed:', result);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: result.Message || 'Payment initialisation failed' }),
    };
  } catch (err) {
    console.error('T-Bank fetch error:', err);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not reach payment service' }),
    };
  }
};
