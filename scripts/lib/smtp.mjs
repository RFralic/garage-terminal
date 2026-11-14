// smtp.mjs: sends one email through Gmail (or any SMTP server on port 465)
// with an app password. Plain Node, no packages.
//
//   await sendMail({ user, pass, to, subject, html, text, fromName, headers })

import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const cleanHeader = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();

function buildMessage({ from, to, subject, html, text, headers = {} }) {
  const boundary = `gt-${randomBytes(12).toString('hex')}`;
  const domain = (/@([^>\s]+)>?\s*$/.exec(from) || [])[1] || 'localhost';
  const head = {
    From: from,
    To: to,
    Subject: encodeHeader(cleanHeader(subject)),
    Date: new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID': `<${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version': '1.0',
    'Content-Type': `multipart/alternative; boundary="${boundary}"`,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, cleanHeader(v)])),
  };
  const lines = Object.entries(head).map(([k, v]) => `${k}: ${v}`);
  const part = (type, body) => [
    `--${boundary}`,
    `Content-Type: ${type}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(body)),
  ].join('\r\n');
  return `${lines.join('\r\n')}\r\n\r\n${part('text/plain', text)}\r\n${part('text/html', html)}\r\n--${boundary}--\r\n`;
}

export async function sendMail({ user, pass, to, subject, html, text, fromName = 'Garage Terminal', headers, host = 'smtp.gmail.com', port = 465 }) {
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(to)) throw new Error('Bad recipient address');
  const from = `"${fromName.replace(/"/g, '')}" <${user}>`;
  const message = buildMessage({ from, to, subject, html, text, headers });

  const socket = tls.connect({ host, port, servername: host });
  socket.setEncoding('utf8');
  socket.setTimeout(30000, () => socket.destroy(new Error('SMTP timed out')));

  let buffer = '';
  const waiting = [];
  const replies = [];
  socket.on('data', (chunk) => {
    buffer += chunk;
    let i;
    let block = '';
    while ((i = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      block += `${line}\n`;
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: +line.slice(0, 3), text: block.trim() };
        block = '';
        if (waiting.length) waiting.shift()(reply); else replies.push(reply);
      }
    }
    if (block) buffer = block.replace(/\n/g, '\r\n') + buffer;
  });
  const failed = new Promise((_, reject) => socket.on('error', reject));
  const next = () => Promise.race([failed, new Promise((resolve) => (replies.length ? resolve(replies.shift()) : waiting.push(resolve)))]);
  const expect = async (codes, what) => {
    const r = await next();
    if (!codes.includes(r.code)) throw new Error(`SMTP ${what}: ${r.text.split('\n').pop()}`);
    return r;
  };
  const send = (line) => socket.write(`${line}\r\n`);

  try {
    await expect([220], 'greeting');
    send('EHLO garage-terminal');
    await expect([250], 'EHLO');
    send(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`);
    await expect([235], 'sign-in (check the address and app password)');
    send(`MAIL FROM:<${user}>`);
    await expect([250], 'MAIL FROM');
    send(`RCPT TO:<${to}>`);
    await expect([250, 251], 'RCPT TO');
    send('DATA');
    await expect([354], 'DATA');
    socket.write(`${message.replace(/^\./gm, '..')}\r\n.\r\n`);
    await expect([250], 'message');
    send('QUIT');
  } finally {
    socket.end();
  }
}
