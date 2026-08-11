// Tests for engine/smtp-mailer.js — runs a scripted mock SMTP server
// on localhost and verifies the full plaintext transaction.
// Run: node --test test/smtp-mailer.test.js

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { TLSSocket } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendMail } from '../engine/smtp-mailer.js';

function startMockSmtp({ authPlain = true } = {}) {
  const transcript = [];
  let dataMode = false;
  let dataChunks = [];
  let loginState = null; // null | 'expect_user' | 'expect_pass'

  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 mock ESMTP ready\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            transcript.push({ data: dataChunks.join('\n') });
            socket.write('250 OK queued\r\n');
          } else {
            dataChunks.push(line);
          }
          continue;
        }
        transcript.push(line);
        const upper = line.toUpperCase();
        if (loginState === 'expect_user') {
          loginState = 'expect_pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (loginState === 'expect_pass') {
          loginState = null;
          socket.write('235 accepted\r\n');
        } else if (upper.startsWith('EHLO')) {
          socket.write(`250-mock\r\n250-AUTH ${authPlain ? 'PLAIN LOGIN' : 'LOGIN'}\r\n250 OK\r\n`);
        } else if (upper.startsWith('AUTH PLAIN')) {
          socket.write('235 accepted\r\n');
        } else if (upper.startsWith('AUTH LOGIN')) {
          loginState = 'expect_user';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 OK\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          socket.write('250 OK\r\n');
        } else if (upper === 'DATA') {
          dataMode = true;
          dataChunks = [];
          socket.write('354 go ahead\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, transcript });
    });
  });
}

describe('sendMail (plaintext transport against mock server)', () => {
  it('performs the full SMTP transaction with AUTH PLAIN', async () => {
    const mock = await startMockSmtp();
    try {
      const result = await sendMail(
        {
          host: '127.0.0.1',
          port: mock.port,
          secure: 'none',
          user: 'jakub@example.com',
          pass: 'secret',
          from: 'jakub@example.com',
          to: 'jakub@example.com, second@example.com',
        },
        { subject: 'Kaufradar Wochenbericht', html: '<h1>Hällo</h1>' }
      );
      assert.equal(result.ok, true);

      const lines = mock.transcript.filter((l) => typeof l === 'string');
      assert.ok(lines.some((l) => l.startsWith('EHLO')));
      assert.ok(lines.some((l) => l.startsWith('AUTH PLAIN ')));
      const authLine = lines.find((l) => l.startsWith('AUTH PLAIN '));
      const decoded = Buffer.from(authLine.slice('AUTH PLAIN '.length), 'base64').toString('utf8');
      assert.equal(decoded, '\u0000jakub@example.com\u0000secret');
      assert.ok(lines.includes('MAIL FROM:<jakub@example.com>'));
      assert.ok(lines.includes('RCPT TO:<jakub@example.com>'));
      assert.ok(lines.includes('RCPT TO:<second@example.com>'));

      const data = mock.transcript.find((l) => typeof l === 'object')?.data || '';
      assert.match(data, /Content-Type: text\/html/);
      // Subject is UTF-8/base64 encoded
      assert.match(data, /Subject: =\?UTF-8\?B\?/);
      // Body is base64 — decode and verify
      const bodyB64 = data.split('\n\n').slice(1).join('').replace(/\s/g, '');
      assert.match(Buffer.from(bodyB64, 'base64').toString('utf8'), /Hällo/);
    } finally {
      mock.server.close();
    }
  });

  it('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
    const mock = await startMockSmtp({ authPlain: false });
    try {
      const result = await sendMail(
        { host: '127.0.0.1', port: mock.port, secure: 'none', user: 'u', pass: 'p', from: 'a@b.c', to: 'x@y.z' },
        { subject: 't', text: 'hello' }
      );
      assert.equal(result.ok, true);
      const lines = mock.transcript.filter((l) => typeof l === 'string');
      assert.ok(lines.includes('AUTH LOGIN'));
    } finally {
      mock.server.close();
    }
  });

  it('rejects when required fields are missing', async () => {
    await assert.rejects(() => sendMail({ host: '', to: 'x@y.z' }, { subject: 't' }), /host missing/);
    await assert.rejects(() => sendMail({ host: 'h', from: 'a@b.c', to: '' }, { subject: 't' }), /recipient missing/);
  });
});

// ---------------------------------------------------------------------------
// STARTTLS — the transport shape smtp.protonmail.ch:587 uses. The mock
// upgrades the socket to TLS after the STARTTLS command (self-signed cert,
// client passes allow_self_signed), then requires AUTH before accepting mail.
// ---------------------------------------------------------------------------

describe('sendMail (STARTTLS upgrade, Proton-style)', () => {
  let tlsOptions;
  let certDir;

  before(() => {
    certDir = mkdtempSync(join(tmpdir(), 'homelander-smtp-tls-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1',
      '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
    ], { stdio: 'ignore' });
    tlsOptions = {
      key: readFileSync(join(certDir, 'key.pem')),
      cert: readFileSync(join(certDir, 'cert.pem')),
    };
    process.on('exit', () => rmSync(certDir, { recursive: true, force: true }));
  });

  function startStartTlsMock() {
    const state = { secured: false, authed: false, data: null };
    const server = createServer((rawSocket) => {
      let socket = rawSocket;
      let dataMode = false;
      let dataChunks = [];
      const attach = (sock) => {
        sock.setEncoding('utf8');
        let buffer = '';
        sock.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\r\n')) !== -1) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (dataMode) {
              if (line === '.') {
                dataMode = false;
                state.data = dataChunks.join('\n');
                sock.write('250 queued\r\n');
              } else dataChunks.push(line);
              continue;
            }
            const upper = line.toUpperCase();
            if (upper.startsWith('EHLO')) {
              sock.write(state.secured ? '250-mock\r\n250-AUTH PLAIN\r\n250 OK\r\n' : '250-mock\r\n250-STARTTLS\r\n250 OK\r\n');
            } else if (upper === 'STARTTLS') {
              sock.write('220 go ahead\r\n');
              sock.removeAllListeners('data');
              const secure = new TLSSocket(rawSocket, { isServer: true, ...tlsOptions });
              state.secured = true;
              socket = secure;
              attach(secure);
            } else if (upper.startsWith('AUTH PLAIN')) {
              state.authed = true;
              sock.write('235 accepted\r\n');
            } else if (upper === 'DATA') {
              dataMode = true;
              dataChunks = [];
              sock.write('354 send\r\n');
            } else if (upper === 'QUIT') {
              sock.write('221 bye\r\n');
              sock.end();
            } else {
              sock.write('250 OK\r\n');
            }
          }
        });
      };
      rawSocket.write('220 mock ESMTP\r\n');
      attach(rawSocket);
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
    });
  }

  it('upgrades to TLS, authenticates, and delivers over the secured channel', async () => {
    const mock = await startStartTlsMock();
    try {
      const result = await sendMail(
        {
          host: '127.0.0.1',
          port: mock.port,
          secure: 'starttls',
          allow_self_signed: true,
          user: 'homelander@example.eu',
          pass: 'smtp-token',
          from: 'homelander@example.eu',
          to: 'me@example.com',
        },
        { subject: 'Wochenbericht', html: '<h1>Report</h1>' }
      );
      assert.equal(result.ok, true);
      assert.equal(mock.state.secured, true, 'TLS upgrade happened');
      assert.equal(mock.state.authed, true, 'AUTH happened after upgrade');
      assert.match(mock.state.data, /Content-Type: text\/html/);
    } finally {
      mock.server.close();
    }
  });
});
