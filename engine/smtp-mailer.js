// Minimal SMTP client — no dependencies, enough for weekly scan reports.
//
// Supports the three transport shapes users actually have:
//   • implicit TLS  (port 465, secure: 'ssl')
//   • STARTTLS      (port 587/1025, secure: 'starttls') — Proton Mail Bridge
//     runs on 127.0.0.1:1025 with a self-signed cert, hence allow_self_signed
//   • plaintext     (secure: 'none', local relays only)
// Auth: AUTH PLAIN with AUTH LOGIN fallback.
//
// ProtonMail note: Proton has no public SMTP endpoint for regular accounts —
// mail is sent through the locally running Proton Mail Bridge app (Mail Plus/
// Unlimited plans) or an SMTP submission token (Business). Both work here.

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const CRLF = '\r\n';

function isLocalHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host || '').toLowerCase());
}

class SmtpConnection {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.buffer = '';
    this.waiters = [];
    this.closed = false;
    this.attach(socket);
  }

  attach(socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this.drain();
    });
    const fail = (err) => {
      this.closed = true;
      const waiter = this.waiters.shift();
      if (waiter) waiter.reject(err instanceof Error ? err : new Error('SMTP connection closed'));
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('SMTP connection closed')));
  }

  drain() {
    // A reply is complete when the last line is "NNN <text>" (space, not dash)
    const lines = this.buffer.split(CRLF);
    let consumed = 0;
    let replyLines = [];
    for (let i = 0; i < lines.length - 1; i++) {
      replyLines.push(lines[i]);
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        consumed = replyLines.join(CRLF).length + CRLF.length;
        this.buffer = this.buffer.slice(consumed);
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve({ code: parseInt(lines[i].slice(0, 3), 10), text: replyLines.join('\n') });
        }
        replyLines = [];
        i = -1;
        lines.length = 0;
        lines.push(...this.buffer.split(CRLF));
      }
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMTP timeout')), this.timeoutMs);
      this.waiters.push({ resolve, reject, timer });
      this.drain();
    });
  }

  async command(line, expectCodes) {
    this.socket.write(line + CRLF);
    const reply = await this.read();
    if (expectCodes && !expectCodes.includes(reply.code)) {
      const label = line.startsWith('AUTH') ? 'AUTH ***' : line.split(' ')[0];
      throw new Error(`SMTP ${label} failed: ${reply.text}`);
    }
    return reply;
  }

  end() {
    this.closed = true;
    try { this.socket.end(); } catch { /* already closed */ }
    try { this.socket.destroy(); } catch { /* already closed */ }
  }
}

function wrapBase64(base64) {
  return base64.replace(/(.{76})/g, `$1${CRLF}`);
}

function buildMime({ from, to, subject, html, text }) {
  const body = html || `<pre>${String(text || '')}</pre>`;
  return [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    `Subject: =?UTF-8?B?${Buffer.from(String(subject || ''), 'utf8').toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <homelander-${Date.now()}-${Math.random().toString(36).slice(2)}@localhost>`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(String(body), 'utf8').toString('base64')),
  ].join(CRLF);
}

/**
 * Send a mail via SMTP.
 * @param {object} smtp  { host, port, secure: 'ssl'|'starttls'|'none',
 *                         user, pass, from, to, allow_self_signed }
 * @param {object} mail  { subject, html, text }
 */
export async function sendMail(smtp, mail, { timeoutMs = 30000 } = {}) {
  const host = String(smtp.host || '').trim();
  const port = Number(smtp.port) || (smtp.secure === 'ssl' ? 465 : 587);
  if (!host) throw new Error('SMTP host missing');
  const from = String(smtp.from || smtp.user || '').trim();
  const recipients = String(Array.isArray(smtp.to) ? smtp.to.join(',') : smtp.to || '')
    .split(/[,;]/).map(v => v.trim()).filter(Boolean);
  if (!from) throw new Error('SMTP from address missing');
  if (recipients.length === 0) throw new Error('SMTP recipient missing');

  const allowSelfSigned = smtp.allow_self_signed ?? isLocalHost(host);
  const tlsOptions = { host, port, rejectUnauthorized: !allowSelfSigned, servername: isLocalHost(host) ? undefined : host };

  const socket = await new Promise((resolve, reject) => {
    const raw = smtp.secure === 'ssl'
      ? tlsConnect(tlsOptions, () => resolve(raw))
      : netConnect({ host, port }, () => resolve(raw));
    raw.setTimeout(timeoutMs, () => { raw.destroy(); reject(new Error('SMTP connect timeout')); });
    raw.on('error', reject);
  });
  socket.setTimeout(0);

  const conn = new SmtpConnection(socket, timeoutMs);
  try {
    const greeting = await conn.read();
    if (greeting.code !== 220) throw new Error(`SMTP greeting failed: ${greeting.text}`);
    let ehlo = await conn.command('EHLO homelander.local', [250]);

    if (smtp.secure !== 'ssl' && smtp.secure !== 'none') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP server does not offer STARTTLS');
      await conn.command('STARTTLS', [220]);
      const upgraded = await new Promise((resolve, reject) => {
        const tlsSocket = tlsConnect({ socket, ...tlsOptions }, () => resolve(tlsSocket));
        tlsSocket.on('error', reject);
      });
      socket.removeAllListeners('data');
      socket.removeAllListeners('error');
      socket.removeAllListeners('close');
      conn.attach(upgraded);
      ehlo = await conn.command('EHLO homelander.local', [250]);
    }

    if (smtp.user) {
      const plain = Buffer.from(`\u0000${smtp.user}\u0000${smtp.pass || ''}`, 'utf8').toString('base64');
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
        await conn.command(`AUTH PLAIN ${plain}`, [235]);
      } else {
        await conn.command('AUTH LOGIN', [334]);
        await conn.command(Buffer.from(String(smtp.user), 'utf8').toString('base64'), [334]);
        await conn.command(Buffer.from(String(smtp.pass || ''), 'utf8').toString('base64'), [235]);
      }
    }

    await conn.command(`MAIL FROM:<${from}>`, [250]);
    for (const rcpt of recipients) {
      await conn.command(`RCPT TO:<${rcpt}>`, [250, 251]);
    }
    await conn.command('DATA', [354]);
    const mime = buildMime({ from, to: recipients, subject: mail.subject, html: mail.html, text: mail.text });
    await conn.command(mime + CRLF + '.', [250]);
    try { await conn.command('QUIT', [221]); } catch { /* server may close first */ }
    return { ok: true };
  } finally {
    conn.end();
  }
}
