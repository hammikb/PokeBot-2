import { TARGET_CART_POLICY, TargetCartBudget, TargetCartBudgetError } from './TargetCartPolicy.js'

export async function runTargetCartAttempt({
  tcin,
  requestedQuantity,
  productUrl,
  policy = TARGET_CART_POLICY,
  now = () => Date.now(),
  sleep,
  acquireButton,
  getProbableEvidence,
  clickAndObserve,
  verifyCart,
  dismissTransient,
  restoreProduct,
  isProductPageValid,
  onEvent = () => {}
}) {
  const budget = new TargetCartBudget({ startedAt: now(), policy })
  let pendingRetryKind = null

  const emit = (state, fields = {}) => onEvent({ state, ...budget.snapshot(now()), ...fields })

  const reloadProduct = async (reason) => {
    budget.recordReload(now())
    emit('reloading_product', { reason })
    await restoreProduct(productUrl)
    pendingRetryKind = 'reload'
  }

  const confirm = async (candidate) => {
    emit('cart_confirming', {
      evidenceSource: candidate.source,
      mutationStatus: candidate.mutationStatus
    })
    const cartState = await verifyCart(candidate)
    if (!cartState?.present || !Number.isInteger(cartState.quantity) || cartState.quantity < 1) {
      await reloadProduct('authoritative-verification-failed')
      return null
    }
    const snapshot = budget.snapshot(now())
    emit('cart_ready', { evidenceSource: candidate.source })
    return {
      tcin,
      quantity: cartState.quantity,
      requestedQuantity,
      unitPrice: cartState.unitPrice ?? null,
      source: candidate.source,
      mutationStatus: candidate.mutationStatus ?? null,
      clickCount: snapshot.clickCount,
      retryCount: snapshot.retryCount,
      reloadCount: snapshot.reloadCount,
      confirmedAt: new Date(now()).toISOString()
    }
  }

  while (true) {
    budget.assertTimeRemaining(now())

    if (!(await isProductPageValid())) {
      await reloadProduct('product-page-replaced')
      continue
    }

    const evidenceBeforeAcquire = await getProbableEvidence()
    if (evidenceBeforeAcquire) {
      const confirmed = await confirm(evidenceBeforeAcquire)
      if (confirmed) return confirmed
      continue
    }

    if (pendingRetryKind === 'no-response' && !budget.canRetryNoResponse()) {
      await reloadProduct('no-response-limit')
      continue
    }

    emit('availability_wait')
    const button = await acquireButton({ pollMs: policy.pollMs })

    const evidenceBeforeClick = await getProbableEvidence()
    if (evidenceBeforeClick) {
      const confirmed = await confirm(evidenceBeforeClick)
      if (confirmed) return confirmed
      continue
    }

    budget.authorizeClick(pendingRetryKind, now())
    pendingRetryKind = null
    emit('cart_response_wait')
    const outcome = await clickAndObserve(button, { outcomeMs: policy.outcomeMs })
    emit('outcome_classified', { kind: outcome.kind, status: outcome.status })

    if (outcome.kind === 'success') {
      const confirmed = await confirm(outcome.evidence)
      if (confirmed) return confirmed
      continue
    }

    if (outcome.kind === 'session-error') {
      throw new Error(`Target cart session rejected with HTTP ${outcome.status}`)
    }

    if (outcome.kind === 'no-response') {
      pendingRetryKind = 'no-response'
      continue
    }

    if (outcome.kind === 'transient' || outcome.kind === 'rate-limit') {
      await dismissTransient()
      const delayMs =
        outcome.kind === 'rate-limit'
          ? (outcome.retryAfterMs ?? policy.rateLimitDelayMs)
          : policy.transientDelayMs
      budget.assertDelayFits(delayMs, now())
      emit(outcome.kind === 'rate-limit' ? 'rate_limited' : 'transient_recovery', {
        delayMs,
        retryAfterHonored: outcome.kind === 'rate-limit' && outcome.retryAfterMs !== null
      })
      await sleep(delayMs)
      pendingRetryKind = outcome.kind
      continue
    }

    throw new Error(`Unsupported Target cart outcome: ${outcome.kind}`)
  }
}

export { TargetCartBudgetError }
