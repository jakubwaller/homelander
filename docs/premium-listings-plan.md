# IS24 Premium Listings — Future Plan

## Problem

Fredy's IS24 scraper uses the **mobile API** (`api.mobile.immobilienscout24.de`) unauthenticated.
Premium/Plus listings are website-exclusive — the mobile API doesn't return them.

This is IS24-specific. Every other platform Fredy supports (Immowelt, Kleinanzeigen, Immonet, WG-Gesucht)
uses HTML scraping and already captures premium listings.

## Three approaches (ranked)

### 1. Authenticated mobile API (TRY FIRST)
- Log into the mobile API with a real IS24 account
- Replay search requests with the auth token
- The IS24 app shows premium listings — so the API must surface them when authenticated
- Effort: 2-4 hours (mitmproxy the app, capture auth, compare results)
- Risk: Unknown if it works
- Advantage: Cleanest — same architecture, ~20 lines of code

### 2. Chrome-based premium scraper (FALLBACK)
- Navigate already-authenticated Chrome to IS24 search results
- Parse listing cards for IDs the mobile API didn't return
- Feed into Fredy's pipeline via `GET /expose/{id}` (already implemented)
- Effort: ~100 lines
- Risk: Low Datadome risk — residential IP + existing session cookies
- Disadvantage: Adds browser dependency to Fredy's IS24 path

### 3. Email scraper (SAFETY NET)
- Connect via IMAP to mailbox receiving IS24 "Neue Suchergebnisse" alerts
- Parse HTML emails for premium listing IDs/links
- Effort: ~50 lines
- Risk: Zero (no bot detection, just reading email)
- Disadvantage: Hours of lag, depends on saved-search email settings, fragile to template changes

---

## Key insight

IS24's `GET /expose/{id}` endpoint returns full listing details regardless of premium status.
The only problem is **discovering premium listing IDs**. Once you have an ID, the rest works.

## Status

Not implemented. Working without premium for now.
