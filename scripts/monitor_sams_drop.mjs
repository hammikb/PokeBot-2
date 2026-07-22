import * as cheerio from 'cheerio'

const productUrl =
  process.argv[2] ||
  'https://www.samsclub.com/ip/Pok-mon-TCG-Mega-Evolution-Ascended-Heroes-Focused-Fighters-Premium-Collection/20186272756'
const stopAt = new Date()
stopAt.setHours(20, 50, 0, 0)
if (stopAt <= new Date()) stopAt.setDate(stopAt.getDate() + 1)

let previous = ''
let checks = 0
let nextDelayMs = 10_000

while (new Date() < stopAt) {
  const checkedAt = new Date()
  try {
    const response = await fetch(productUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36'
      },
      redirect: 'follow'
    })
    const html = await response.text()
    const $ = cheerio.load(html)
    const raw = $('#__NEXT_DATA__').text()
    let product = null
    try {
      product = raw ? JSON.parse(raw)?.props?.pageProps?.initialData?.data?.product : null
    } catch {
      // State below reports an unparseable response.
    }
    const shipping = product?.fulfillmentOptions?.find((option) => option.type === 'SHIPPING')
    const addToCartVisible = /add to cart/i.test($('body').text())
    const state = {
      http: response.status,
      finalUrl: response.url,
      product: product?.name || null,
      productStatus: product?.availabilityStatus || null,
      shippingStatus: shipping?.availabilityStatus || null,
      viewOnly: shipping?.viewOnly ?? null,
      quantity: shipping?.availableQuantity ?? null,
      specialCta: product?.specialCtaType || null,
      addToCartVisible,
      price: product?.priceInfo?.currentPrice?.price ?? null
    }
    const serialized = JSON.stringify(state)
    const actionable =
      response.ok &&
      product?.availabilityStatus === 'IN_STOCK' &&
      shipping?.availabilityStatus === 'IN_STOCK' &&
      shipping?.viewOnly !== true &&
      shipping?.restricted !== true &&
      Number(shipping?.availableQuantity || 0) > 0

    checks += 1
    nextDelayMs = [403, 429].includes(response.status) ? 60_000 : 10_000
    if (serialized !== previous) {
      console.log(`${checkedAt.toISOString()} STATE ${serialized}`)
      previous = serialized
    } else if (checks % 6 === 0) {
      console.log(`${checkedAt.toISOString()} HEARTBEAT unchanged`)
    }
    if (actionable) {
      console.log(`${checkedAt.toISOString()} ACTIONABLE Sam's Club shipping offer is live`)
      process.stdout.write('\u0007')
    }
  } catch (error) {
    console.log(`${checkedAt.toISOString()} ERROR ${error.message}`)
    nextDelayMs = 60_000
  }
  await new Promise((resolve) => setTimeout(resolve, nextDelayMs))
}

console.log(`${new Date().toISOString()} COMPLETE monitoring window ended at 8:50 PM Pacific`)
