// Unit tests for IS24Contactor verification logic.
// Mocks page.evaluate to simulate different IS24 responses.
// Run: node --test test/is24-contactor.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IS24Contactor } from '../engine/is24-contactor.js';

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

  it('premium upsell (Suchen+)', async () => {
    const c = mockContactor();
    // formGone=true + premium=true → old code returned SUCCESS, new code returns FAILURE
    c.page.evaluate = evaluateSeq(failState({ formGone: true, premium: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /premium upsell/);
  });

  it('server error (rate-limit) — treated as premium immediately', async () => {
    const c = mockContactor();
    // Server error = premium, no retries
    c.page.evaluate = evaluateSeq(failState({ serverError: true }));
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /premium/);
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

  it('formGone + structural premium gate at deadline → FAILURE', async () => {
    const c = mockContactor();
    c.verifyDeadlineMs = 0;
    c.page.evaluate = evaluateSeq(
      () => ({ formGone: true, premium: true, serverError: false }),
    );
    const r = await c._verifySubmission();
    assert.equal(r.verified, false);
    assert.match(r.detail, /premium upsell/);
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
