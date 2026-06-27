// Unit tests for IS24Contactor verification logic.
// Mocks page.evaluate to simulate different IS24 responses.
// Run: node --test test/is24-contactor.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IS24Contactor, extractExposeIdsFromText } from '../engine/is24-contactor.js';

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
// Nachrichten expose ID extraction tests
// ============================================================================
describe('extractExposeIdsFromText() — Nachrichten sync', () => {
  it('extracts expose IDs from links, query params, and embedded page data', () => {
    const ids = extractExposeIdsFromText(
      'https://www.immobilienscout24.de/expose/123456789',
      'https://www.immobilienscout24.de/somewhere?exposeId=987654321&foo=bar',
      '{"exposeId":"112233445"}',
      'duplicate https://www.immobilienscout24.de/expose/123456789',
    ).sort();
    assert.deepEqual(ids, ['112233445', '123456789', '987654321']);
  });
});

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
// _waitForForm() tests
// ============================================================================
describe('_waitForForm() — form variants', () => {
  it('accepts contact form without message textarea', async () => {
    const c = mockContactor();
    c.page.evaluate = async () => true;
    assert.equal(await c._waitForForm(1), true);
  });

  it('clicks visible Nachricht CTA when form is not open yet', async () => {
    const c = mockContactor();
    let checks = 0;
    let opened = false;
    c._isContactFormOpen = async () => {
      checks++;
      return opened;
    };
    c._openContactFormIfNeeded = async () => {
      opened = true;
      return true;
    };
    assert.equal(await c._waitForForm(100), true);
    assert.ok(checks >= 2);
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

  it('premium upsell after submit is not classified as premium', async () => {
    const c = mockContactor();
    // Premium classification is only trusted before submit: click Nachricht → upsell/no form.
    // After a real form opened, a disappearing form with generic Plus text is unconfirmed, not premium.
    c.page.evaluate = evaluateSeq(failState({ formGone: true, premium: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
  });

  it('server error ("Es ist ein Fehler aufgetreten.") → PREMIUM', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(failState({ serverError: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /PREMIUM_ONLY/);
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

  it('explicit success text → SUCCESS', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ successText: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /success text/);
  });

  it('form disappears without confirmation → FAILURE', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ formGone: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
  });

  it('form disappears while logged out → SESSION_EXPIRED', async () => {
    const c = mockContactor();
    c.page.evaluate = evaluateSeq(okState({ formGone: true, loggedOut: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SESSION_EXPIRED/);
  });
});

describe('_verifySubmission() — deadline timeout', () => {
  // The poll loop runs until deadline. To test deadline behavior without waiting,
  // set verifyDeadlineMs=0 and return the final structural fallback state.

  it('formGone + explicit success text at deadline → SUCCESS', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: true, premium: false, loggedOut: false, successText: true, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, true);
    assert.match(r.detail, /success text/);
  });

  it('formGone + generic Suchen+ marketing text at deadline → FAILURE, not premium', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: true, premium: false, loggedOut: false, successText: false, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
  });

  it('formGone + structural premium gate at deadline → unconfirmed, not premium', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: true, premium: true, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
    assert.doesNotMatch(r.detail, /premium/i);
  });

  it('formGone but no confirmation at deadline → FAILURE', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: true, premium: false, loggedOut: false, successText: false, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /SUBMIT_UNCONFIRMED/);
  });

  it('no signal at all at deadline → FAILURE', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: false, premium: false, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /no confirmation/);
  });
});
