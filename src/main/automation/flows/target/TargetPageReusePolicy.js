const RECOVERABLE_FAILURES = [
  /target browser add-to-cart was not confirmed/i,
  /target did not confirm the requested item in the cart/i,
  /target high-demand add-to-cart retry window expired/i,
  /target fulfillment is still loading/i,
  /target availability did not settle/i,
  /net::err_aborted/i,
  // Target redirects the slugless /p/-/A-<tcin> form to its canonical URL, which aborts
  // the in-flight goto. The session is untouched, so keep the warm page.
  /interrupted by another navigation/i,
  // TargetCartBudgetError exhaustion: pre-submission and retryable, so keep the warm
  // session rather than discarding the page and re-solving the queue from scratch.
  /target cart acquisition exhausted (deadline|retry-limit|no-response-limit|reload-limit)/i
]

const UNSAFE_FAILURES = [
  /http 401|http 403/i,
  /signed? out|not signed in/i,
  /security challenge|captcha/i,
  /wrong product|unexpected product/i,
  /out of stock|sold out|no longer available/i,
  /page, context or browser has been closed/i
]

export function classifyTargetPageReuse({ error, page, orderSubmissionAttempted = false }) {
  if (orderSubmissionAttempted) {
    return { preserve: false, reason: 'submission-attempted' }
  }
  if (!page || page.isClosed?.()) {
    return { preserve: false, reason: 'page-closed' }
  }

  let hostname = ''
  try {
    hostname = new URL(page.url?.() || '').hostname.toLowerCase()
  } catch {
    return { preserve: false, reason: 'invalid-origin' }
  }
  if (hostname !== 'target.com' && !hostname.endsWith('.target.com')) {
    return { preserve: false, reason: 'non-target-origin' }
  }

  const message = String(error?.message || error || '')
  if (UNSAFE_FAILURES.some((pattern) => pattern.test(message))) {
    return { preserve: false, reason: 'unsafe-failure' }
  }
  if (RECOVERABLE_FAILURES.some((pattern) => pattern.test(message))) {
    return { preserve: true, reason: 'recoverable-pre-submission-failure' }
  }
  return { preserve: false, reason: 'unclassified-failure' }
}
