// resend.mjs: sends one email through Resend (resend.com) from the site's own
// domain, garageterminal.com. Plain fetch, no packages.
//
//   await sendMail({ apiKey, from, to, subject, html, text, replyTo, headers })
//
// The domain is verified in Resend (its DNS records are on Cloudflare); the
// API key is the RESEND_API_KEY GitHub secret.

export async function sendMail({ apiKey, from, to, subject, html, text, replyTo, headers }) {
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(to)) throw new Error('Bad recipient address');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: String(subject).replace(/[\r\n]+/g, ' ').trim(),
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(headers ? { headers } : {}),
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    let why = `${res.status}`;
    try { const j = await res.json(); why = `${res.status} ${j.name || ''} ${j.message || ''}`.trim(); } catch { /* keep status */ }
    throw new Error(`Resend: ${why}`);
  }
  return res.json();
}
