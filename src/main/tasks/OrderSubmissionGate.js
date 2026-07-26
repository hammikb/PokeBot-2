export class OrderSubmissionGate {
  constructor(limit = 1) {
    this.limit = Math.max(1, Math.min(Number(limit) || 1, 20))
    this.claims = new Set()
  }

  claim(key) {
    const normalized = String(key || '').trim()
    if (!normalized) throw new Error('Order submission claim requires a key')
    if (this.claims.has(normalized)) return true
    if (this.claims.size >= this.limit) return false
    this.claims.add(normalized)
    return true
  }

  snapshot() {
    return { limit: this.limit, claimed: this.claims.size }
  }
}
