// Shared stats normalization — resolves shape differences between
// all-time getStats() (total-based) and live daemon/today payloads (seen-based).
// Duplicated in App.jsx + SearchTab.jsx before extraction (audit item 15).

const DUPLICATE_PROTECTION_DEFAULTS = {
  duplicateProtectionStatus: 'ready',
  messengerCheckedAt: null,
  messengerExposeIdsSeen: 0,
  messengerConversationsChecked: 0,
  messengerPendingRowsProtected: 0,
  messengerNewFutureSkips: 0,
  messengerPagesScanned: 0,
  messengerSource: null,
  messengerSyncError: null,
};

function duplicateProtectionFields(fresh) {
  return {
    duplicateProtectionStatus: fresh.duplicateProtectionStatus || DUPLICATE_PROTECTION_DEFAULTS.duplicateProtectionStatus,
    messengerCheckedAt: fresh.messengerCheckedAt || null,
    messengerExposeIdsSeen: fresh.messengerExposeIdsSeen ?? fresh.messenger_expose_ids_seen ?? 0,
    messengerConversationsChecked: fresh.messengerConversationsChecked ?? fresh.messenger_conversations_checked ?? fresh.messengerExposeIdsSeen ?? 0,
    messengerPendingRowsProtected: fresh.messengerPendingRowsProtected ?? fresh.messenger_pending_rows_protected ?? fresh.protected ?? 0,
    messengerNewFutureSkips: fresh.messengerNewFutureSkips ?? fresh.messenger_new_future_skips ?? fresh.future_skips ?? 0,
    messengerPagesScanned: fresh.messengerPagesScanned ?? fresh.messenger_pages_scanned ?? fresh.pages ?? 0,
    messengerSource: fresh.messengerSource || fresh.messenger_source || null,
    messengerSyncError: fresh.messengerSyncError || fresh.messenger_sync_error || null,
  };
}

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
      ...duplicateProtectionFields(fresh),
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
    ...duplicateProtectionFields(fresh),
  };
}
