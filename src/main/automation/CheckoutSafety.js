export function parseDisplayedPrice(value) {
  const matches = [...String(value || '').matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]
    .map((match) => Number(match[1].replace(/,/g, '')))
    .filter((price) => Number.isFinite(price) && price >= 0)
  return matches.length ? Math.min(...matches) : null
}

export function validateCheckoutSafety({
  retailer,
  expectedItemId,
  actualItemId,
  requestedQuantity = 1,
  actualQuantity,
  maxUnitPrice = null,
  actualUnitPrice = null,
  seller = null,
  requireRetailerSeller = false
}) {
  if (expectedItemId && String(actualItemId || '') !== String(expectedItemId)) {
    throw new Error(`${retailer} checkout could not verify the requested item ${expectedItemId}`)
  }

  const requested = Math.max(1, Number(requestedQuantity) || 1)
  if (!Number.isInteger(actualQuantity) || actualQuantity < 1) {
    throw new Error(`${retailer} checkout could not verify the requested item quantity`)
  }
  if (actualQuantity > requested) {
    throw new Error(
      `${retailer} cart quantity ${actualQuantity} exceeds requested maximum ${requested}`
    )
  }

  if (maxUnitPrice != null) {
    const limit = Number(maxUnitPrice)
    if (!Number.isFinite(actualUnitPrice)) {
      throw new Error(`${retailer} checkout could not verify the item price`)
    }
    if (Number(actualUnitPrice) > limit) {
      throw new Error(
        `${retailer} item price $${Number(actualUnitPrice).toFixed(2)} exceeds maximum $${limit.toFixed(2)}`
      )
    }
  }

  if (
    requireRetailerSeller &&
    !new RegExp(`sold\\s+(?:and\\s+shipped\\s+)?by\\s+${retailer}`, 'i').test(seller || '')
  ) {
    throw new Error(`${retailer} checkout could not verify that the item is sold by ${retailer}`)
  }

  return {
    itemId: String(actualItemId),
    quantity: actualQuantity,
    unitPrice: actualUnitPrice,
    seller: seller || null
  }
}

export async function readRetailerCartItem(page, expectedItemId) {
  return page.evaluate((itemId) => {
    const links = [...document.querySelectorAll(`a[href*="${CSS.escape(String(itemId))}"]`)]
    const link =
      links.find((element) => {
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }) || links[0]
    if (!link) return null

    const row =
      link.closest(
        'article, li, [data-testid*="cart-item" i], [data-automation-id*="cart-item" i], [data-testid*="order-item" i]'
      ) || link.parentElement
    const text = String(row?.innerText || row?.textContent || '')
    const quantityControl = row?.querySelector(
      'select[aria-label*="quantity" i], input[aria-label*="quantity" i], [aria-label*="current quantity" i], button[aria-label*="quantity" i]'
    )
    const quantityText =
      quantityControl?.value ||
      quantityControl?.getAttribute('aria-valuenow') ||
      quantityControl?.getAttribute('aria-label') ||
      quantityControl?.textContent ||
      text
    const quantityMatch = String(quantityText).match(
      /(?:current\s+)?quantity\s*[:,-]?\s*(\d+)|(?:qty|quantity)\s*[:,-]?\s*(\d+)|^\s*(\d+)\s*$/i
    )
    const quantity = Number(quantityMatch?.[1] || quantityMatch?.[2] || quantityMatch?.[3])
    const priceElement = row?.querySelector(
      '[itemprop="price"], [data-automation-id*="product-price" i], [data-testid*="price" i], [aria-label*="current price" i]'
    )
    const priceText = String(priceElement?.textContent || text)
    const priceMatches = [...priceText.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)]
      .map((match) => Number(match[1].replace(/,/g, '')))
      .filter((price) => Number.isFinite(price) && price >= 0)
    const seller = text.match(/sold\s+and\s+shipped\s+by\s+[^\n]+/i)?.[0] || null

    return {
      itemId: String(itemId),
      quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : null,
      unitPrice: priceMatches.length ? Math.min(...priceMatches) : null,
      seller
    }
  }, String(expectedItemId))
}
