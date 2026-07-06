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

  // Extract buyer email from DATA field.
  // T-Bank echoes DATA as a JSON-encoded string in the webhook notification.
  let buyerEmail = null;
  if (body.DATA) {
    try {
      const data = typeof body.DATA === 'string' ? JSON.parse(body.DATA) : body.DATA;
      buyerEmail = data.Email || null;
    } catch {
      console.error('payment-webhook: could not parse DATA field', { OrderId });
    }
  }

  // Send confirmation email only on successful payment statuses.
  if ((Status === 'CONFIRMED' || Status === 'AUTHORIZED') && buyerEmail) {
    const resendKey = process.env.RESEND_API_KEY;
    const emailFrom = process.env.EMAIL_FROM;

    if (!resendKey || !emailFrom) {
      console.error('payment-webhook: missing RESEND_API_KEY or EMAIL_FROM env vars', { OrderId });
    } else {
      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${resendKey}`,
          },
          body: JSON.stringify({
            from: emailFrom,
            to: buyerEmail,
            subject: 'Добро пожаловать на курс «Мышление в эпоху ИИ»',
            text: `Здравствуйте!

Спасибо, что присоединились к курсу «Мышление в эпоху ИИ».

Мы очень рады, что вы стали частью программы!

Чтобы ничего не пропустить, пожалуйста, обязательно присоединитесь к Telegram-каналу курса по ссылке ниже. Именно там будет публиковаться вся важная информация: анонсы, ссылки на встречи, домашние задания, дополнительные материалы и объявления.

👉 Ссылка на Telegram-канал:
https://t.me/+iPOnVU0xq_RlYzZi

👉 Ссылка на Telegram-чат:
https://t.me/+inJ2IYxm9Fs4NTli

Рекомендуем присоединиться сразу после получения этого письма, чтобы быть в курсе всех обновлений с первого дня.

До встречи на программе!`,
          }),
        });

        if (emailRes.ok) {
          console.log('payment-webhook: email sent', { OrderId, buyerEmail });
        } else {
          const errBody = await emailRes.text();
          console.error('payment-webhook: email send failed', { OrderId, status: emailRes.status, errBody });
        }
      } catch (err) {
        console.error('payment-webhook: email error', { OrderId, err: err.message });
      }
    }
  }

  // T-Bank requires the response body to be exactly "OK"
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain' },
    body: 'OK',
  };
};
