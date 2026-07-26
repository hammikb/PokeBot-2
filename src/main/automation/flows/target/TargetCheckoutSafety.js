import { validateCheckoutSafety } from '../../CheckoutSafety.js'

export function validateTargetCartForCheckout({ tcin, cartState, buyLimit = 1, maxPrice = null }) {
  if (!cartState?.present) {
    throw new Error('Target did not confirm the requested item in the cart')
  }
  if (!Number.isInteger(cartState.quantity) || cartState.quantity < 1) {
    throw new Error('Target cart quantity could not be verified for the requested item')
  }

  const requestedQuantity = Math.max(1, Number(buyLimit) || 1)
  const snapshot = validateCheckoutSafety({
    retailer: 'Target',
    expectedItemId: tcin,
    actualItemId: tcin,
    requestedQuantity,
    actualQuantity: cartState.quantity,
    maxUnitPrice: maxPrice,
    actualUnitPrice: cartState.unitPrice
  })

  return {
    ...snapshot,
    requestedQuantity,
    quantityLimited: cartState.quantity < requestedQuantity
  }
}
