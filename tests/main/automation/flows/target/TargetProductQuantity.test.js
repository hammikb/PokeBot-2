import { describe, expect, it, vi } from 'vitest'
import {
  readTargetProductQuantity,
  setTargetProductQuantity,
  waitForTargetQuantityControl
} from '../../../../../src/main/automation/flows/target.js'

// Each control shape Target has shipped, plus the case that caused the bug:
// no control matches at all, which must report null instead of silently passing.
function makePage(controls) {
  const handleFor = (match) => ({
    count: async () => (match ? 1 : 0),
    evaluate: async () => match.read(),
    selectOption: async ({ value }) => match.write(value),
    fill: async (value) => match.write(value),
    press: async () => {},
    click: async () => match.write(String(Number(match.read()) + 1))
  })
  return {
    waitForTimeout: vi.fn(async () => {}),
    locator: vi.fn((selector) => {
      const match = controls.find((control) => control.matches(selector))
      const handle = handleFor(match)
      return {
        ...handle,
        // Real locators expose count/nth alongside first().
        count: async () => (match ? 1 : 0),
        nth: () => handle,
        first: () => handle
      }
    })
  }
}

describe('Target product quantity', () => {
  it('sets quantity through a <select>', async () => {
    let value = '1'
    const page = makePage([
      {
        matches: (s) => s.includes('@web/QuantitySelector'),
        read: () => value,
        write: (next) => {
          value = next
        }
      }
    ])
    await expect(setTargetProductQuantity(page, 2)).resolves.toBe(2)
    expect(value).toBe('2')
  })

  it('steps up to the requested quantity when only a +/- stepper exists', async () => {
    let value = '1'
    const page = makePage([
      {
        matches: (s) => s.includes('qtyStepperValue') || s.includes('qtyStepperUp'),
        read: () => value,
        write: (next) => {
          value = next
        }
      }
    ])
    await expect(setTargetProductQuantity(page, 3)).resolves.toBe(3)
    expect(value).toBe('3')
  })

  it('reports null when no quantity control matches instead of silently passing', async () => {
    const page = makePage([])
    await expect(readTargetProductQuantity(page)).resolves.toBeNull()
    await expect(setTargetProductQuantity(page, 2)).resolves.toBeNull()
  })

  it('reports the stuck value when the control refuses to move', async () => {
    const page = makePage([
      {
        matches: (s) => s.includes('@web/QuantitySelector'),
        read: () => '1',
        write: () => {}
      }
    ])
    await expect(setTargetProductQuantity(page, 2)).resolves.toBe(1)
  })

  it("drives Target's real custom listbox trigger via the option's aria-label", async () => {
    // Markup verified against a live PDP: options are anchors keyed by aria-label,
    // not role="option", and the digit sits in a nested div beside an <svg>.
    //   <ul class="Options_styles_options__hQoz_">
    //     <li><a href="#" aria-label="2 - selected"><div>2</div><svg/></a></li>
    let value = '1'
    let open = false
    const handle = (selector) => ({
      count: async () => {
        if (selector.includes('quantityValue') || selector.includes('selectCustomButton')) return 1
        if (selector.includes('aria-label')) return open ? 1 : 0
        return 0
      },
      evaluate: async () => value,
      click: async () => {
        if (selector.includes('selectCustomButton')) open = true
        else if (selector.includes('aria-label') && open) {
          value = selector.match(/aria-label="(\d+)"/)[1]
          open = false
        }
      },
      selectOption: async () => {},
      fill: async () => {},
      press: async () => {}
    })
    const page = {
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn((selector) => {
        const h = handle(selector)
        return { ...h, nth: () => h, first: () => h }
      })
    }

    await expect(setTargetProductQuantity(page, 2)).resolves.toBe(2)
    expect(value).toBe('2')
  })

  it('waits for the control to mount instead of reporting it missing straight away', async () => {
    // Target renders the quantity dropdown a beat after the Add to cart button; a
    // single point-in-time read called it missing on 14 of 17 live attempts.
    let mounted = false
    const page = {
      waitForTimeout: vi.fn(async () => {
        mounted = true
      }),
      locator: vi.fn((selector) => ({
        first: () => ({
          count: async () => (mounted && selector.includes('quantityValue') ? 1 : 0),
          evaluate: async () => '1'
        })
      }))
    }
    await expect(waitForTargetQuantityControl(page, { timeoutMs: 1000 })).resolves.toBe(1)
    expect(page.waitForTimeout).toHaveBeenCalled()
  })

  it('gives up once the wait budget is spent', async () => {
    const page = {
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn(() => ({ first: () => ({ count: async () => 0 }) }))
    }
    const stamps = [0, 0, 5000]
    const realNow = Date.now
    Date.now = () => (stamps.length > 1 ? stamps.shift() : stamps[0])
    try {
      await expect(waitForTargetQuantityControl(page, { timeoutMs: 100 })).resolves.toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('sets every fulfillment section, not just the first', async () => {
    // Live PDP has two independent quantity controls sharing one CTA id:
    //   @web/AddToCart/Fulfillment/ShippingSection  and  StickyAddToCartFulfillmentSection
    // Setting only the first left the sticky bar on 1, so a click landing there added 1.
    const sections = ['1', '1']
    let openIndex = null
    const page = {
      waitForTimeout: vi.fn(async () => {}),
      locator: vi.fn((selector) => {
        const isTrigger =
          selector.includes('selectCustomButton') || selector.includes('quantityValue')
        const forIndex = (index) => ({
          count: async () => (isTrigger ? 1 : openIndex !== null ? 1 : 0),
          evaluate: async () => sections[index],
          click: async () => {
            if (isTrigger) openIndex = index
            else if (openIndex !== null) {
              sections[openIndex] = selector.match(/aria-label="(\d+)"/)[1]
              openIndex = null
            }
          },
          selectOption: async () => {},
          fill: async () => {},
          press: async () => {}
        })
        return {
          ...forIndex(0),
          count: async () => (isTrigger ? sections.length : openIndex !== null ? 1 : 0),
          nth: (index) => forIndex(index),
          first: () => forIndex(openIndex ?? 0)
        }
      })
    }

    await setTargetProductQuantity(page, 2)
    expect(sections).toEqual(['2', '2'])
  })
})
