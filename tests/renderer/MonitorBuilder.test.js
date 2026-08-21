import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const componentPath = fileURLToPath(
  new URL('../../src/renderer/src/components/MonitorBuilder.jsx', import.meta.url)
)

describe('MonitorBuilder retailer controls', () => {
  it('renders retailer configuration controls only when the retailer is enabled', () => {
    const source = readFileSync(componentPath, 'utf8')

    expect(source).toMatch(/source\.enabled\s*\?\s*\(/)
    expect(source).toMatch(/source\.enabled\s*\?\s*['"]Enabled['"]\s*:/)
  })
})
