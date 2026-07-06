const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const orderId = event.queryStringParameters && event.queryStringParameters.orderId;
  if (!orderId) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing orderId' }),
    };
  }

  const terminalKey = process.env.TBANK_TERMINAL_KEY;
  const password    = process.env.TBANK_PASSWORD;

  if (!terminalKey || !password) {
    console.error('payment-status: missing env vars');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Payment service not configured' }),
    };
  }

  // Token for CheckOrder: OrderId, Password, TerminalKey — sorted alphabetically
  const tokenParams = {
    OrderId:     orderId,
    Password:    password,
    TerminalKey: terminalKey,
  };
  const tokenStr = Object.keys(tokenParams)
    .sort()
    .map(k => tokenParams[k])
    .join('');
  const token = crypto.createHash('sha256').update(tokenStr).digest('hex');

  try {
    const tRes = await fetch('https://securepay.tinkoff.ru/v2/CheckOrder', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ TerminalKey: terminalKey, OrderId: orderId, Token: token }),
    });

    const result = await tRes.json();

    if (!result.Success) {
      console.error('payment-status: CheckOrder failed', result.Message, 'OrderId:', orderId);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false, status: 'UNKNOWN', error: result.Message }),
      };
    }

    const payments = result.Payments || [];
    if (payments.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: false, status: 'NOT_FOUND' }),
      };
    }

    // Scan all payments for a confirmed status — array sort order is not documented by T-Bank.
    // A single OrderId can have multiple payment entries (e.g. internal retries), so position-
    // based access ([0] or [-1]) is unreliable. Any CONFIRMED or AUTHORIZED entry means paid.
    const paidPayment = payments.find(p => p.Status === 'CONFIRMED' || p.Status === 'AUTHORIZED');
    if (paidPayment) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paid: true, status: paidPayment.Status }),
      };
    }

    // No paid entry — return the most specific terminal failure status found.
    const TERMINAL_PRIORITY = ['REJECTED', 'CANCELED', 'DEADLINE_EXPIRED'];
    const terminalStatus = TERMINAL_PRIORITY.find(s => payments.some(p => p.Status === s));
    const status = terminalStatus || payments[payments.length - 1].Status || 'UNKNOWN';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paid: false, status }),
    };
  } catch (err) {
    console.error('payment-status: CheckOrder error', err);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not reach payment service' }),
    };
  }
};
