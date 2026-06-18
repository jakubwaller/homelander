// Unit tests for IS24Contactor verification logic.
// Mocks page.evaluate to simulate different IS24 responses.
// Run: node --test test/is24-contactor.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IS24Contactor } from '../src/is24-contactor.js';

/** Create a contactor with a mocked page. */
function mockContactor() {
  const c = new IS24Contactor('http://localhost:9222', {}, 'balanced', {}, {});
  c.page = {
    evaluate: async () => ({}),  // overridden per-test
    screenshot: async () => {},
    close: async () => {},
    title: async () => '',
  };
  return c;
}

/** Return a function that returns each state in sequence, repeats the last. */
function evaluateSeq(...states) {
  let i = 0;
  return async () => {
    const s = states[Math.min(i, states.length - 1)];
    i++;
    return typeof s === 'function' ? s() : s;
  };
}

// ============================================================================
// _isBlocked() tests
// ============================================================================
describe('_isBlocked() — captcha detection', () => {
  it('title "Roboter"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'Roboter-Check';
    assert.equal(await c._isBlocked(), true);
  });
  it('title "Sicherheitsprüfung"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'Sicherheitsprüfung';
    assert.equal(await c._isBlocked(), true);
  });
  it('title "Sicherheitsabfrage"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'Sicherheitsabfrage';
    assert.equal(await c._isBlocked(), true);
  });
  it('body "Ich bin kein Roboter"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'IS24';
    c.page.evaluate = async () => 'Ich bin kein Roboter';
    assert.equal(await c._isBlocked(), true);
  });
  it('body "Sicherheitsabfrage" + "Zeichen aus dem Bild"', async () => {
    const c = mockContactor();
    c.page.title = async () => 'IS24';
    c.page.evaluate = async () => 'Sicherheitsabfrage: hy5bp — Zeichen aus dem Bild eingeben';
    assert.equal(await c._isBlocked(), true);
  });
  it('normal page → false', async () => {
    const c = mockContactor();
    c.page.title = async () => 'IS24';
    c.page.evaluate = async () => 'Wohnung mieten Hamburg 3 Zimmer';
    assert.equal(await c._isBlocked(), false);
  });
});

// ============================================================================
// _verifySubmission() tests
// ============================================================================
describe('_verifySubmission() — failure branches', () => {
  const failState = (overrides) => ({
    confirmed: false, formGone: false, captcha: false,
    serverError: false, premium: false, hasErrors: false, validationText: false,
    ...overrides,
  });

  it('captcha (state.captcha)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(failState({ captcha: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /captcha/);
  });

  it('premium upsell (Suchen+)', async () => {
    const c = mockContactor();
    // formGone=true + premium=true → old code returned SUCCESS, new code returns FAILURE
    c.page.evaluate = evaluateSeq(failState({ formGone: true, premium: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /premium upsell/);
  });

  it('server error (rate-limit) — retries, eventually times out', async () => {
    const c = mockContactor();
    // Server error with form still present → retries keep looping.
    // After 5s deadline, formGone=false → "no confirmation"
    let call = 0;
    c.page.evaluate = async () => {
      call++;
      // Poll loop: 1 iteration fits in 5s with 2-4s server-error jitter
      if (call === 1) {
        return { confirmed: false, formGone: false, captcha: false, serverError: true, premium: false, hasErrors: false, validationText: false };
      }
      // Deadline check 1: formGone (must return boolean)
      if (call === 2) return false;
      // Deadline check 2: bodyText
      return '';
    };
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /no confirmation/);
  });

  it('validation errors (hasErrors)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(failState({ hasErrors: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /validation/);
  });

  it('validation text (Pflichtfeld)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(failState({ validationText: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /validation/);
  });
});

describe('_verifySubmission() — success branches', () => {
  const okState = (overrides) => ({
    confirmed: false, formGone: false, captcha: false,
    serverError: false, premium: false, hasErrors: false, validationText: false,
    ...overrides,
  });

  it('confirmation modal → SUCCESS (fast path)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ confirmed: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /modal/);
  });

  it('form disappears → SUCCESS', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ formGone: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /form removed/);
  });

  it('form disappears + thanks → SUCCESS (thanks is ignored)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ formGone: true, thanks: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /form removed/);
  });

  it('form disappears + sent → SUCCESS (sent is ignored)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ formGone: true, sent: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /form removed/);
  });
});

describe('_verifySubmission() — deadline timeout', () => {
  // The poll loop runs for ~5s. To test deadline behavior without waiting,
  // we feed states that keep the loop going (no clear signal) until it expires,
  // then provide final evaluate() results for the deadline checks.
  //
  // The deadline makes 2 evaluate() calls: (1) check formGone, (2) read bodyText.
  // We provide enough "no signal" states for the polling loop + 2 for deadline.

  it('formGone + any text at deadline → SUCCESS (text is ignored)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(
      // Poll loop — no clear signal, keeps going
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      // Deadline check #1: formGone = true
      () => true,
      // Deadline check #2: any text (no longer relevant — formGone is enough)
      () => 'Vielen Dank für Ihre Nachricht!',
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /form removed/);
  });

  it('formGone + Suchen+ at deadline → FAILURE', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      () => true,           // formGone
      () => 'Suchen+ Tarif wählen Jetzt Plus Mitgliedschaft',  // premium text
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /premium upsell/);
  });

  it('formGone but no text at deadline → SUCCESS (formGone is enough)', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      () => true,           // formGone
      () => 'Keine Bestätigung sichtbar auf dieser Seite',  // irrelevant
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /form removed/);
  });

  it('no signal at all at deadline → FAILURE', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      { confirmed: false, formGone: false, captcha: false,
        serverError: false, premium: false, hasErrors: false, validationText: false },
      () => false,          // formGone = false
      () => '',             // empty bodyText
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /no confirmation/);
  });
});
