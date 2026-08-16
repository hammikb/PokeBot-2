/* eslint-disable react/prop-types */

const STAGE_ORDER = [
  'drop_detected',
  'browser_launch',
  'product_opened',
  'session_checked',
  'availability_ready',
  'cart_attempted',
  'cart_ready',
  'queue_waiting',
  'checkout_opened',
  'checkout_ready',
  'order_submitted',
  'confirmed',
  'manual_required',
  'failed'
]

export default function CheckoutAttemptObservability({ attempt }) {
  const milestones = Array.isArray(attempt?.milestones) ? attempt.milestones : []
  const cartAttempts = Array.isArray(attempt?.cartAttempts) ? attempt.cartAttempts : []
  const leaseSummary = attempt?.leaseSummary

  if (!milestones.length && !cartAttempts.length && !leaseSummary) return null

  return (
    <section className="mb-5 space-y-4 border-b border-gray-800 pb-5">
      <MilestoneStrip milestones={milestones} />
      <CartAttemptTable attempts={cartAttempts} />
      <LeaseSummary leaseSummary={leaseSummary} />
    </section>
  )
}

function MilestoneStrip({ milestones }) {
  if (!milestones.length) return null
  const orderedMilestones = [...milestones].sort(
    (left, right) => stageIndex(left.stage) - stageIndex(right.stage)
  )

  return (
    <div>
      <p className="detail-label mb-2">Milestones</p>
      <div className="flex flex-wrap gap-2">
        {orderedMilestones.map((milestone) => (
          <div
            key={milestone.stage}
            className={`rounded border px-2.5 py-1.5 text-[11px] ${
              milestone.reached
                ? 'border-sky-800/70 bg-sky-950/25 text-sky-200'
                : 'border-gray-800 bg-[#111] text-gray-600'
            }`}
          >
            <span>{labelize(milestone.stage)}</span>
            <span className="ml-2 text-[10px] text-gray-500">
              {milestone.reached ? formatDuration(milestone.reachedMs) : 'Not reached'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CartAttemptTable({ attempts }) {
  if (!attempts.length) return null

  return (
    <div>
      <p className="detail-label mb-2">Cart attempts</p>
      <div className="overflow-x-auto rounded border border-gray-800 bg-[#101010]">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-gray-800 text-[10px] uppercase tracking-wider text-gray-600">
            <tr>
              <th className="px-3 py-2 font-medium">Elapsed</th>
              <th className="px-3 py-2 font-medium">Attempt</th>
              <th className="px-3 py-2 font-medium">Result</th>
              <th className="px-3 py-2 font-medium">HTTP</th>
              <th className="px-3 py-2 font-medium">Retry delay</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/70 text-gray-400">
            {attempts.map((cartAttempt, index) => (
              <tr key={`${cartAttempt.elapsedMs}:${cartAttempt.attemptNumber}:${index}`}>
                <td className="px-3 py-2 text-gray-500">{formatDuration(cartAttempt.elapsedMs)}</td>
                <td className="px-3 py-2">{formatAttemptNumber(cartAttempt)}</td>
                <td className="px-3 py-2 text-gray-200">{formatCartResult(cartAttempt)}</td>
                <td className="px-3 py-2">{cartAttempt.httpStatus ?? '—'}</td>
                <td className="px-3 py-2">{formatDuration(cartAttempt.delayMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function LeaseSummary({ leaseSummary }) {
  if (!leaseSummary) return null
  const accountBusy = leaseSummary.contended || leaseSummary.state === 'busy'

  return (
    <div>
      <p className="detail-label mb-1">Account summary</p>
      <p className={accountBusy ? 'text-xs text-amber-300' : 'text-xs text-gray-400'}>
        {accountBusy
          ? 'Account busy'
          : leaseSummary.heldMs == null
            ? `Account lease ${labelize(leaseSummary.state)}`
            : `Account lease held ${formatDuration(leaseSummary.heldMs)}`}
      </p>
    </div>
  )
}

function stageIndex(stage) {
  const index = STAGE_ORDER.indexOf(stage)
  return index === -1 ? STAGE_ORDER.length : index
}

function formatAttemptNumber(attempt) {
  if (attempt.attemptNumber != null) return `Attempt ${attempt.attemptNumber}`
  if (attempt.retryNumber != null) return `Retry ${attempt.retryNumber}`
  return '—'
}

function formatCartResult(attempt) {
  const result = attempt.responseKind || attempt.retryKind || attempt.eventType
  if (!result) return 'Recorded'
  if (result === 'rate_limit') return 'Rate limit'
  return labelize(result)
}

function formatDuration(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  const milliseconds = Math.max(0, Number(value))
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`
  if (milliseconds < 60_000)
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`
}

function labelize(value) {
  return String(value || 'unknown')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}
