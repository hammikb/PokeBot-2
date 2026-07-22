const FIELD_SELECTORS = {
  cardNumber:
    'input[autocomplete="cc-number"], input[name*="cardNumber" i], input[id*="card-number" i], input[aria-label*="card number" i]',
  expiry:
    'input[autocomplete="cc-exp"], input[name*="expir" i], input[id*="expir" i], input[aria-label*="expir" i]',
  cvv: 'input[autocomplete="cc-csc"], input[name*="cvv" i], input[name*="securityCode" i], input[id*="cvv" i], input[aria-label*="cvv" i], input[aria-label*="security code" i], input[placeholder*="cvv" i]'
}

export async function fillCheckoutPayment(context, payment, onStep = () => {}) {
  if (!payment) return { filled: [], missing: [] }
  const values = {
    cardNumber: payment.cardNumber,
    expiry: `${String(payment.expiryMonth).padStart(2, '0')}/${String(payment.expiryYear).slice(-2)}`,
    cvv: payment.cvv
  }
  const filled = []
  const missing = []

  for (const [field, selector] of Object.entries(FIELD_SELECTORS)) {
    if (values[field] === undefined || values[field] === null || values[field] === '') {
      missing.push(field)
      continue
    }
    const target = await findVisibleField(context, selector)
    if (!target) {
      missing.push(field)
      continue
    }
    onStep(
      `Filling saved ${field === 'cvv' ? 'CVV' : field === 'expiry' ? 'expiration' : 'card number'}`
    )
    await target.fill(String(values[field]))
    filled.push(field)
  }
  return { filled, missing }
}

export async function findVisibleField(contextOrPage, selector) {
  const pages = typeof contextOrPage.pages === 'function' ? contextOrPage.pages() : [contextOrPage]
  for (const page of pages) {
    for (const frame of page.frames()) {
      const locator = frame.locator(selector).first()
      if (
        (await locator.count().catch(() => 0)) > 0 &&
        (await locator.isVisible().catch(() => false))
      ) {
        return locator
      }
    }
  }
  return null
}
