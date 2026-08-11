export async function resolveTargetCartState({ cartEvidence, confirmCart }) {
  if (!cartEvidence) return confirmCart()
  return {
    present: true,
    quantity: cartEvidence.quantity,
    unitPrice: cartEvidence.unitPrice,
    source: cartEvidence.source
  }
}
