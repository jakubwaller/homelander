// Shared stats normalization — resolves shape differences between
// all-time getStats() (total-based) and live daemon/today payloads (seen-based).
// Duplicated in App.jsx + SearchTab.jsx before extraction (audit item 15).

export function normalizeStats(fresh) {
  if (!fresh) return fresh;
  // getStats() returns all-time counters as { total, seen_unapplied, ... }.
  // The dashboard renders queue-style Processed X/Y, so expose a stable
  // `seen` denominator for both all-time and live daemon/today payloads.
  if (fresh.total != null) {
    return {
      seen: (fresh.total || 0) + (fresh.seen_unapplied || 0),
      sent: fresh.sent || 0,
      failed: fresh.failed || 0,
      deactivated: fresh.deactivated || 0,
      premium: fresh.premium || 0,
      captcha: fresh.captcha || 0,
      seen_unapplied: fresh.seen_unapplied || 0,
      today: fresh.today || 0,
      nextPollAt: fresh.nextPollAt || fresh.next_poll_at || null,
    };
  }
  return {
    seen: fresh.seen || 0,
    sent: fresh.sent || 0,
    failed: fresh.failed || 0,
    deactivated: fresh.deactivated || 0,
    premium: fresh.premium || 0,
    captcha: fresh.captcha || 0,
    seen_unapplied: fresh.seen_unapplied || 0,
    today: fresh.today || 0,
    nextPollAt: fresh.nextPollAt || fresh.next_poll_at || null,
  };
}
