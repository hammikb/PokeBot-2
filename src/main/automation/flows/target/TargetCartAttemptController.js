import { TARGET_CART_POLICY, TargetCartBudget, TargetCartBudgetError } from './TargetCartPolicy.js'

// Evidence that Target itself confirmed the add: a 2xx/409 from the cart mutation, or
// its own "Added to cart" UI. Never discard these on a single failed DOM read.
const DEFINITIVE_CART_EVIDENCE = new Set(['mutation-2xx', 'mutation-409', 'visible-added-to-cart'])

function withTargetCartFailureContext(operation, failureKind) {
  try {
    return operation()
  } catch (error) {
    if (error instanceof TargetCartBudgetError) {
      if (failureKind === 'rate-limit') {
        error.message = `Target rate limited Add to cart; ${error.message}`
      } else if (failureKind === 'no-response') {
        error.message = `Target cart no response; ${error.message}`
      }
    }
    throw error
  }
}

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
  recoverAmbiguousCart = async () => null,
  dismissTransient,
  restoreProduct,
  isProductPageValid,
  isSessionAlive = async () => false,
  getInventoryGate = async () => ({ mode: 'fallback', reason: 'inventory-gate-unavailable' }),
  onEvent = () => {}
}) {
  const budget = new TargetCartBudget({ startedAt: now(), policy })
  let pendingRetryKind = null
  let shouldRecoverAmbiguousCart = false
  let consecutiveRateLimits = 0
  let sessionErrorRetries = 0
  let activeDeadlineMs = policy.deadlineMs

  const emit = (state, fields = {}) => onEvent({ state, ...budget.snapshot(now()), ...fields })

  const reloadProduct = async (reason) => {
    withTargetCartFailureContext(
      () => budget.recordReload(now(), activeDeadlineMs),
      pendingRetryKind
    )
    emit('reloading_product', { reason })
    await restoreProduct(productUrl)
    pendingRetryKind = 'reload'
  }

  const refreshInventoryGate = async (failureKind = pendingRetryKind) => {
    const gate = (await getInventoryGate()) || { mode: 'fallback', reason: 'inventory-gate-empty' }
    if (gate.mode === 'stop') {
      throw new TargetCartBudgetError('out-of-stock', budget.snapshot(now()))
    }
    activeDeadlineMs = gate.mode === 'extend' ? policy.inventoryDeadlineMs : policy.deadlineMs
    // Still confirmed in stock: let the run outlive the click/reload caps and keep
    // trying until the inventory deadline, instead of failing after four retries
    // while the drop is visibly still live.
    budget.setInventoryExtended(gate.mode === 'extend')
    withTargetCartFailureContext(
      () => budget.assertTimeRemaining(now(), activeDeadlineMs),
      failureKind
    )
    return gate
  }

  const usable = (state) =>
    Boolean(state?.present) && Number.isInteger(state.quantity) && state.quantity >= 1

  const settle = (state, candidate, source) => {
    const snapshot = budget.snapshot(now())
    emit('cart_ready', { evidenceSource: source })
    return {
      tcin,
      quantity: state.quantity,
      requestedQuantity,
      unitPrice: state.unitPrice ?? null,
      source,
      mutationStatus: candidate.mutationStatus ?? null,
      clickCount: snapshot.clickCount,
      retryCount: snapshot.retryCount,
      reloadCount: snapshot.reloadCount,
      confirmedAt: new Date(now()).toISOString()
    }
  }

  const confirm = async (candidate) => {
    emit('cart_confirming', {
      evidenceSource: candidate.source,
      mutationStatus: candidate.mutationStatus
    })

    // Target already told us the add landed. A cart-page DOM read that disagrees is far
    // likelier to be a stale render or a changed selector than a genuinely empty cart,
    // so give it several tries before believing it over the mutation response.
    const definitive = DEFINITIVE_CART_EVIDENCE.has(candidate.source)
    const attempts = definitive ? Math.max(1, policy.verificationAttempts) : 1

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const cartState = await verifyCart(candidate)
      if (usable(cartState)) return settle(cartState, candidate, candidate.source)
      if (attempt < attempts) {
        emit('cart_verification_retry', { evidenceSource: candidate.source, attempt })
        await sleep(policy.verificationRetryMs)
      }
    }

    if (definitive) {
      // Second opinion from the header cart count, which does not depend on the
      // cart-row parser that just failed.
      const recovered = await recoverAmbiguousCart()
      if (usable(recovered)) return settle(recovered, candidate, 'header-cart-badge')
      emit('cart_confirmation_abandoned', { evidenceSource: candidate.source })
    }

    await reloadProduct('authoritative-verification-failed')
    return null
  }

  while (true) {
    if (shouldRecoverAmbiguousCart) {
      shouldRecoverAmbiguousCart = false
      const recovered = await recoverAmbiguousCart()
      const recoveryOutcome =
        recovered?.present && Number.isInteger(recovered.quantity) && recovered.quantity > 0
          ? 'present'
          : recovered?.recoveryOutcome === 'timeout'
            ? 'timeout'
            : 'absent'
      emit('ambiguous_cart_recovery', { outcome: recoveryOutcome })
      if (recoveryOutcome === 'present') {
        const snapshot = budget.snapshot(now())
        return {
          tcin,
          quantity: recovered.quantity,
          requestedQuantity,
          unitPrice: recovered.unitPrice ?? null,
          source: 'ambiguous-cart-recovery',
          mutationStatus: null,
          clickCount: snapshot.clickCount,
          retryCount: snapshot.retryCount,
          reloadCount: snapshot.reloadCount,
          confirmedAt: new Date(now()).toISOString()
        }
      }
    }

    const evidenceBeforeAcquire = await getProbableEvidence()
    if (evidenceBeforeAcquire) {
      const confirmed = await confirm(evidenceBeforeAcquire)
      if (confirmed) return confirmed
      continue
    }

    await refreshInventoryGate()

    if (!(await isProductPageValid())) {
      await reloadProduct('product-page-replaced')
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

    await refreshInventoryGate()
    const authorizedRetryKind = pendingRetryKind
    withTargetCartFailureContext(
      () => budget.authorizeClick(pendingRetryKind, now(), activeDeadlineMs),
      pendingRetryKind
    )
    if (authorizedRetryKind === 'no-response') {
      emit('no_response_retry')
    }
    pendingRetryKind = null
    emit('cart_response_wait')
    const outcome = await clickAndObserve(button, { outcomeMs: policy.outcomeMs })
    emit('outcome_classified', { kind: outcome.kind, status: outcome.status })
    consecutiveRateLimits = outcome.kind === 'rate-limit' ? consecutiveRateLimits + 1 : 0

    if (outcome.kind === 'success') {
      const confirmed = await confirm(outcome.evidence)
      if (confirmed) return confirmed
      continue
    }

    if (outcome.kind === 'session-error') {
      // Target 401s the cart endpoint while throttling an account whose session is
      // still perfectly valid, and says so on the page: "Something went wrong and the
      // item was not added to your cart. Please try again." Killing the tab there
      // threw away a warm, signed-in session over a retryable throttle. Only treat it
      // as fatal once the page confirms we are actually signed out.
      if (!(await isSessionAlive())) {
        throw new Error(`Target cart session rejected with HTTP ${outcome.status}`)
      }
      emit('session_error_retry', { status: outcome.status })
      await dismissTransient()
      const delayMs = Math.min(
        policy.maxRateLimitDelayMs,
        policy.rateLimitDelayMs * 2 ** Math.min(sessionErrorRetries, 3)
      )
      sessionErrorRetries += 1
      await refreshInventoryGate('rate-limit')
      withTargetCartFailureContext(
        () => budget.assertDelayFits(delayMs, now(), activeDeadlineMs),
        'rate-limit'
      )
      await sleep(delayMs)
      pendingRetryKind = 'rate-limit'
      continue
    }

    if (outcome.kind === 'no-response') {
      pendingRetryKind = 'no-response'
      shouldRecoverAmbiguousCart = true
      continue
    }

    if (outcome.kind === 'transient' || outcome.kind === 'rate-limit') {
      await dismissTransient()
      // Target answers its 429s with `Retry-After: 0`, and `??` only falls back on
      // null - so a literal 0 used to pass through and hot-loop the add-to-cart
      // click with no backoff at all. Floor it, and back off while the 429s persist.
      // A real Retry-After is Target telling us exactly when to come back, so honor it.
      // But Target answers most of its 429s with `Retry-After: 0`, and `??` only falls
      // back on null - a literal 0 used to pass straight through and hot-loop the click
      // with no backoff. Treat a useless value as absent: floor it, and escalate while
      // the 429s keep coming.
      const backoffMs = Math.min(
        policy.maxRateLimitDelayMs,
        policy.rateLimitDelayMs * 2 ** Math.min(Math.max(0, consecutiveRateLimits - 1), 3)
      )
      const delayMs =
        outcome.kind === 'rate-limit'
          ? outcome.retryAfterMs > 0
            ? outcome.retryAfterMs
            : backoffMs
          : policy.transientDelayMs
      await refreshInventoryGate(outcome.kind)
      withTargetCartFailureContext(
        () => budget.assertDelayFits(delayMs, now(), activeDeadlineMs),
        outcome.kind
      )
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
