/** Formats an epoch-ms timestamp as "3m ago" style relative text, for at-a-glance staleness. */
export function formatRelativeTime(epochMs: number, nowMs: number = Date.now()): string {
  const diffMs = Math.max(0, nowMs - epochMs);
  const sec = Math.round(diffMs / 1000);

  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;

  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;

  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;

  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function formatPrice(priceCents: number | null, currency: string | null): string | null {
  if (priceCents === null || currency === null) return null;
  const amount = (priceCents / 100).toFixed(2);
  return `${amount} ${currency}`;
}
