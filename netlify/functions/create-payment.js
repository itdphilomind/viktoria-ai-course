const crypto = require('crypto');

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

  const orderId = `itd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const amount  = 2800000; // 28 000 RUB in kopecks

  // T-Bank token: sort all param keys alphabetically (excl. DATA/Receipt/Token),
  // include Password, concatenate values, SHA-256.
  const tokenParams = {
    Amount:      String(amount),
    Description: 'Мышление в эпоху ИИ',
    OrderId:     orderId,
    Password:    password,
    TerminalKey: terminalKey,
  };
  const tokenStr = Object.keys(tokenParams)
    .sort()
    .map(k => tokenParams[k])
    .join('');
  const token = crypto.createHash('sha256').update(tokenStr).digest('hex');

  const payload = {
    TerminalKey: terminalKey,
    Amount:      amount,
    OrderId:     orderId,
    Description: 'Мышление в эпоху ИИ',
    DATA: {
      Name:     name,
      Email:    email,
      Phone:    phone,
      Telegram: telegram,
    },
    Token: token,
  };

  try {
    const tRes = await fetch('https://securepay.tinkoff.ru/v2/Init', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const result = await tRes.json();

    if (result.Success && result.PaymentURL) {
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
