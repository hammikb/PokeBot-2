import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { describe, expect, it, vi } from 'vitest'
import { lookupProductWithScrapling } from '../../../src/main/products/ScraplingLookup.js'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  existsSync: vi.fn(() => true)
}))

vi.mock('child_process', () => ({
  spawn: mocks.spawn
}))

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: mocks.existsSync
}))

function mockPythonRun({ stdout = '', stderr = '', code = 0, error = null }) {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  mocks.spawn.mockReturnValueOnce(child)
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout)
    if (stderr) child.stderr.write(stderr)
    child.stdout.end()
    child.stderr.end()
    if (error) child.emit('error', error)
    else child.emit('close', code)
  })
  return child
}

describe('lookupProductWithScrapling', () => {
  it('returns product JSON from the Python Scrapling helper', async () => {
    mockPythonRun({
      stdout: JSON.stringify({
        ok: true,
        product: {
          retailer: 'target',
          productUrl: 'https://www.target.com/p/guppy/A-95225595',
          productName: 'Pokemon Scrapling Product',
          source: 'scrapling'
        }
      })
    })

    const product = await lookupProductWithScrapling('https://www.target.com/p/guppy/A-95225595', {
      pythonCommand: 'python'
    })

    expect(product).toMatchObject({
      productName: 'Pokemon Scrapling Product',
      source: 'scrapling'
    })
  })

  it('throws an unavailable error when Scrapling is not installed', async () => {
    mockPythonRun({
      stderr: JSON.stringify({
        ok: false,
        code: 'missing_dependency',
        error: 'Scrapling is not installed'
      }),
      code: 3
    })

    await expect(
      lookupProductWithScrapling('https://www.target.com/p/guppy/A-95225595', {
        pythonCommand: 'python'
      })
    ).rejects.toMatchObject({ code: 'SCRAPLING_UNAVAILABLE' })
  })

  it('throws a retailer block shaped error when Scrapling sees a robot check', async () => {
    mockPythonRun({
      stderr: JSON.stringify({
        ok: false,
        code: 'blocked',
        status: 403,
        error: 'Retailer page is showing a CAPTCHA or robot check'
      }),
      code: 4
    })

    await expect(
      lookupProductWithScrapling('https://www.target.com/p/guppy/A-95225595', {
        pythonCommand: 'python'
      })
    ).rejects.toMatchObject({
      status: 403,
      response: { status: 403 }
    })
  })
})
