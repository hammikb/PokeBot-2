import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP('http://127.0.0.1:63512')
const [ctx] = b.contexts()
for (const page of ctx.pages()) {
  try {
    const r = await page.evaluate(() => {
      const txt = document.body.innerText || ''
      const triggers = [...document.querySelectorAll('button[class*="selectCustomButton"]')].map(t => ({
        id: t.id,
        value: t.querySelector('[class*="quantityValue"]')?.textContent,
        section: t.closest('[data-test*="Fulfillment" i],[data-test*="Sticky" i]')?.getAttribute('data-test')
      }))
      const ctas = [...document.querySelectorAll('button')]
        .filter(x => /AddToCartButton|preorderButton|orderPickupButton/.test(x.getAttribute('data-test')||''))
        .map(x => ({ dt: x.getAttribute('data-test'), text: (x.innerText||'').trim().slice(0,20), disabled: x.disabled,
                     section: x.closest('[data-test*="Fulfillment" i],[data-test*="Sticky" i]')?.getAttribute('data-test') }))
      const badge = document.querySelector('[data-test="@web/CartLinkQuantity"]')
      const sheet = [...document.querySelectorAll('[role="dialog"],[role="alert"],[aria-live]')]
        .find(e => /not added|something went wrong|high.demand/i.test(e.innerText||''))
      const sr = sheet?.getBoundingClientRect()
      return {
        url: location.href,
        stock: /out of stock|sold out/i.test(txt.slice(0,4000)) ? 'OOS' : 'in-stock?',
        cartBadge: badge?.textContent ?? null,
        triggers, ctas,
        sheet: sheet ? {
          tag: sheet.tagName, role: sheet.getAttribute('role'),
          ariaLive: sheet.getAttribute('aria-live'),
          rect: { w: Math.round(sr.width), h: Math.round(sr.height) },
          text: (sheet.innerText||'').replace(/\s+/g,' ').slice(0,110),
          html: sheet.outerHTML.slice(0,300)
        } : null
      }
    })
    console.log(JSON.stringify(r, null, 1))
  } catch (e) { console.log('page probe failed:', page.url().slice(0,60), e.message.slice(0,80)) }
}
await b.close()
