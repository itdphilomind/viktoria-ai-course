const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const password    = process.env.TBANK_PASSWORD;
  const terminalKey = process.env.TBANK_TERMINAL_KEY;

  if (!password || !terminalKey) {
    console.error('payment-webhook: missing env vars');
    return { statusCode: 500, body: 'Server configuration error' };
  }

  // Reject notifications not addressed to our terminal
  if (body.TerminalKey !== terminalKey) {
    console.error('payment-webhook: TerminalKey mismatch', body.TerminalKey);
    return { statusCode: 400, body: 'Invalid terminal' };
  }

  // Verify token:
  // - Remove Token field from body
  // - Add Password
  // - Sort all keys alphabetically
  // - Concatenate string values
  // - SHA-256 must equal Token
  const { Token: receivedToken, ...fields } = body;
  const tokenParams = { ...fields, Password: password };

  const tokenStr = Object.keys(tokenParams)
    .sort()
    .map(k => String(tokenParams[k]))
    .join('');
  const expectedToken = crypto.createHash('sha256').update(tokenStr).digest('hex');

  if (receivedToken !== expectedToken) {
    console.error('payment-webhook: token mismatch', { OrderId: body.OrderId, Status: body.Status });
    return { statusCode: 400, body: 'Token mismatch' };
  }

  const { OrderId, PaymentId, Status, Amount, Success } = body;
  console.log('payment-webhook:', JSON.stringify({ OrderId, PaymentId, Status, Amount, Success }));

  // T-Bank requires the response body to be exactly "OK"
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain' },
    body: 'OK',
  };
};
