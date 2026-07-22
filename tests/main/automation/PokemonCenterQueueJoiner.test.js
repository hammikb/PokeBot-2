import { describe, expect, it, vi } from 'vitest'
import { PokemonCenterQueueJoiner } from '../../../src/main/automation/PokemonCenterQueueJoiner.js'

function pageWith(text, url = 'https://www.pokemoncenter.com/') {
  const frame = {
    locator: () => ({ innerText: async () => text })
  }
  return { frames: () => [frame], url: () => url }
}

describe('PokemonCenterQueueJoiner', () => {
  it('detects the queue copy and parses its estimated wait', async () => {
    const joiner = new PokemonCenterQueueJoiner({ browserPool: {} })
    const state = await joiner._readQueueState(
      pageWith(
        "You're in the virtual queue to enter Pokémon Center! Estimated wait time: 00:02:00 Keep this window open"
      )
    )
    expect(state).toEqual({ inQueue: true, etaSec: 120 })
  })

  it('does not mistake the normal storefront for a queue', async () => {
    const joiner = new PokemonCenterQueueJoiner({ browserPool: {} })
    const state = await joiner._readQueueState(pageWith('Shop Pokémon cards and plush'))
    expect(state.inQueue).toBe(false)
  })

  it('opens the trusted default browser only once when there is no saved profile', async () => {
    const openExternal = vi.fn(async () => {})
    const joiner = new PokemonCenterQueueJoiner({ browserPool: {}, openExternal })

    joiner.start('auto', {
      productUrl: 'https://www.pokemoncenter.com/',
      label: 'Pokemon Center Queue',
      account: null
    })
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))

    joiner.start('auto', {
      productUrl: 'https://www.pokemoncenter.com/',
      label: 'Pokemon Center Queue',
      account: null
    })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(joiner.isJoining('auto')).toBe(true)
    await joiner.stop('auto')
  })

  it('opens the system browser when selected even with a saved managed profile', async () => {
    const openExternal = vi.fn(async () => {})
    const browserPool = { pin: vi.fn() }
    const joiner = new PokemonCenterQueueJoiner({ browserPool, openExternal })

    joiner.start('system-browser', {
      productUrl: 'https://www.pokemoncenter.com/',
      label: 'Pokemon Center Queue',
      account: { id: 'account-1', profile_path: 'C:/profiles/account-1' },
      browserMode: 'system'
    })

    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    expect(browserPool.pin).not.toHaveBeenCalled()
    await joiner.stop('system-browser')
  })
})
