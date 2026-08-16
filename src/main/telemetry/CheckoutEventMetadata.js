const EVENT_TYPES = Object.freeze([
  'cart_click',
  'cart_response',
  'cart_retry',
  'cart_reload',
  'account_lease'
])
const REQUEST_TYPES = Object.freeze(['cart_mutation'])
const RESPONSE_KINDS = Object.freeze([
  'success',
  'session_error',
  'no_response',
  'transient',
  'rate_limit'
])
const RETRY_KINDS = Object.freeze(['rate_limit', 'transient', 'no_response', 'reload'])
const LEASE_STATES = Object.freeze(['acquired', 'released', 'busy'])

const ENUM_FIELDS = Object.freeze({
  eventType: EVENT_TYPES,
  requestType: REQUEST_TYPES,
  responseKind: RESPONSE_KINDS,
  retryKind: RETRY_KINDS,
  leaseState: LEASE_STATES
})

const INTEGER_RANGES = Object.freeze({
  httpStatus: Object.freeze([100, 599]),
  attemptNumber: Object.freeze([1, 10_000]),
  retryNumber: Object.freeze([1, 10_000]),
  delayMs: Object.freeze([0, 86_400_000]),
  heldMs: Object.freeze([0, 86_400_000])
})

const BOOLEAN_FIELDS = Object.freeze(['retryAfterHonored'])
const OWNER_REF_PATTERN = /^[a-f0-9]{20}$/

export function sanitizeCheckoutEventMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}

  const output = {}
  for (const [field, values] of Object.entries(ENUM_FIELDS)) {
    if (Object.hasOwn(input, field) && values.includes(input[field])) output[field] = input[field]
  }
  for (const [field, [minimum, maximum]] of Object.entries(INTEGER_RANGES)) {
    const value = input[field]
    if (
      Object.hasOwn(input, field) &&
      Number.isInteger(value) &&
      value >= minimum &&
      value <= maximum
    ) {
      output[field] = value
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (Object.hasOwn(input, field) && typeof input[field] === 'boolean') output[field] = input[field]
  }
  if (
    Object.hasOwn(input, 'ownerRef') &&
    typeof input.ownerRef === 'string' &&
    OWNER_REF_PATTERN.test(input.ownerRef)
  ) {
    output.ownerRef = input.ownerRef
  }
  return output
}

export function parseCheckoutEventMetadata(value) {
  if (!value) return {}
  try {
    return sanitizeCheckoutEventMetadata(typeof value === 'string' ? JSON.parse(value) : value)
  } catch {
    return {}
  }
}
