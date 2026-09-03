/**
 * Parse the rate-limit reset time from a text message.
 * Returns seconds until reset (minimum 60, default 300).
 */
export function parseRateLimitResetTime(text) {
  const match = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?(UTC|[A-Z]{2,4})\)?/i);
  if (!match) return 300;
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3]?.toLowerCase();
  if (period === 'pm' && hours !== 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;
  const now = new Date();
  const resetTime = new Date(now);
  resetTime.setUTCHours(hours, minutes, 0, 0);
  if (resetTime <= now) resetTime.setUTCDate(resetTime.getUTCDate() + 1);
  return Math.max(60, Math.ceil((resetTime.getTime() - now.getTime()) / 1000));
}
