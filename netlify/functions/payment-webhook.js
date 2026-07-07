const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── DEBUG: log raw body before parsing ──
  try {
    console.log('payment-webhook [debug] raw body type:', typeof event.body);
    console.log('payment-webhook [debug] raw body (first 1000 chars):',
      String(event.body ?? '').slice(0, 1000));
  } catch (e) { /* ignore logging errors */ }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  // ── DEBUG: log parsed field summary ──
  try {
    console.log('payment-webhook [debug] parsed keys:', JSON.stringify(Object.keys(body)));
    console.log('payment-webhook [debug] DATA exists:', 'DATA' in body);
    console.log('payment-webhook [debug] DATA type:', typeof body.DATA);
    console.log('payment-webhook [debug] DATA raw:',
      body.DATA !== undefined ? String(body.DATA).slice(0, 500) : 'NOT PRESENT');
    console.log('payment-webhook [debug] Receipt exists:', 'Receipt' in body);
    console.log('payment-webhook [debug] CustomerKey exists:', 'CustomerKey' in body);
  } catch (e) { console.error('payment-webhook [debug] field summary error:', e.message); }

  // ── DEBUG: check DATA.Email ──
  try {
    if (body.DATA) {
      const parsed = typeof body.DATA === 'string' ? JSON.parse(body.DATA) : body.DATA;
      console.log('payment-webhook [debug] DATA.Email exists:', !!parsed?.Email);
      if (parsed?.Email) {
        console.log('payment-webhook [debug] DATA.Email masked:',
          String(parsed.Email).replace(/^(.{2}).+(@.+)$/, '$1***$2'));
      }
    } else {
      console.log('payment-webhook [debug] DATA.Email exists: false (DATA not present)');
    }
  } catch (e) { console.error('payment-webhook [debug] DATA parse error:', e.message); }

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
  console.log(`payment-webhook:\nOrderId: ${OrderId}\nStatus: ${Status}`);

  // Send confirmation email on successful payment statuses using Netlify Blobs.
  // Blob stores buyer data written at Init time (T-Bank does not echo DATA in webhooks).
  if (Status === 'CONFIRMED' || Status === 'AUTHORIZED') {
    const resendKey = process.env.RESEND_API_KEY;
    const emailFrom = process.env.EMAIL_FROM;

    if (!resendKey || !emailFrom) {
      console.error('payment-webhook: missing RESEND_API_KEY or EMAIL_FROM env vars', { OrderId });
    } else {
      try {
        connectLambda(event);
        const store = getStore('payment-buyers');
        const result = await store.getWithMetadata(OrderId, { type: 'json' });

        if (!result || !result.data) {
          console.error('payment-webhook: no buyer blob found', { OrderId });
          console.log('payment-webhook: Blob not found');
        } else {
          const { data: buyerData, etag } = result;
          const { emailStatus, emailSendingAt } = buyerData;
          console.log(`payment-webhook: Blob found\nemailStatus: ${emailStatus ?? 'null'}`);

          // Already delivered — skip.
          if (emailStatus === 'sent') {
            console.log('payment-webhook: email already sent, skipping', { OrderId });

          // In-flight claim less than 120s old — another invocation is sending, skip.
          } else if (emailStatus === 'sending' && emailSendingAt && (Date.now() - emailSendingAt) < 120_000) {
            console.log('payment-webhook: email send in-flight, skipping', { OrderId, emailSendingAt });

          // Unclaimed (null) or stale abandoned claim — attempt CAS to take ownership.
          } else {
            let claimed = false;
            try {
              await store.set(
                OrderId,
                JSON.stringify({ ...buyerData, emailStatus: 'sending', emailSendingAt: Date.now() }),
                { etag, ttl: 604800 },
              );
              claimed = true;
              console.log('payment-webhook: CAS claim succeeded');
            } catch {
              // ETag mismatch — another webhook claimed first.
              console.log('payment-webhook: CAS claim lost, another invocation owns this order', { OrderId });
              console.log('payment-webhook: CAS conflict (another webhook already claimed it)');
            }

            if (claimed) {
              // We own the send slot. Send email now.
              const buyerEmail = buyerData.email;
              let emailSent = false;

              try {
                console.log('payment-webhook: Sending email via Resend...');
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
                  emailSent = true;
                  console.log('payment-webhook: email sent', { OrderId, buyerEmail });
                  console.log('payment-webhook: Resend success');
                } else {
                  const errBody = await emailRes.text();
                  console.error('payment-webhook: email send failed', { OrderId, status: emailRes.status, errBody });
                  console.log(`payment-webhook: Email sending failed: ${emailRes.status} ${errBody}`);
                }
              } catch (err) {
                console.error('payment-webhook: email fetch error', { OrderId, err: err.message });
                console.log(`payment-webhook: Email sending failed: ${err.message}`);
              }

              // Mark sent only after Resend confirms delivery.
              // If emailSent is false, blob stays "sending" (stale) so the next
              // webhook (e.g. CONFIRMED after AUTHORIZED) can recover and retry.
              if (emailSent) {
                try {
                  await store.setJSON(
                    OrderId,
                    { ...buyerData, emailStatus: 'sent', emailSendingAt },
                    { ttl: 604800 },
                  );
                  console.log('payment-webhook: emailStatus updated to sent');
                } catch (blobErr) {
                  // Non-fatal: email was delivered; "sent" mark will be retried by next webhook
                  // which will see a stale "sending" claim, re-CAS, attempt send, and get a
                  // duplicate — acceptable rare edge case vs losing the confirmation permanently.
                  console.error('payment-webhook: blob "sent" write failed after email delivery', { OrderId, err: blobErr.message });
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('payment-webhook: blob lookup error', { OrderId, err: err.message });
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
