import { chromium } from 'playwright-core'
const b = await chromium.connectOverCDP('http://127.0.0.1:63512')
const [ctx] = b.contexts()
for (const page of ctx.pages()) {
  if (!/target\.com/.test(page.url())) continue
  console.log(JSON.stringify(await page.evaluate(() => {
    const sels = {
      badge: '[data-test="@web/CartLinkQuantity"]',
      cartLinkTest: '[data-test="@web/CartLink"]',
      hrefCart: 'a[href="/cart"]',
      hrefCoCart: 'a[href$="/co-cart"]'
    }
    const out = {}
    for (const [k, s] of Object.entries(sels)) {
      const el = document.querySelector(s)
      out[k] = el ? { found: true, text: (el.textContent||'').trim().slice(0,10), html: el.outerHTML.slice(0,140) } : { found: false }
    }
    // What DOES the cart link look like on this page?
    const anyCart = [...document.querySelectorAll('a[href*="cart"]')].slice(0,3)
      .map(a => ({ href: a.getAttribute('href'), dt: a.getAttribute('data-test'), aria: a.getAttribute('aria-label') }))
    return { ...out, anyCartLinks: anyCart }
  }), null, 1))
}
await b.close()
