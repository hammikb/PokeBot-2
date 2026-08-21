/**
 * Attach to a live checkout browser and report the two things we still cannot match:
 * the quantity dropdown (and its opened listbox) and the "item not added" side sheet.
 *
 * Start the app with a debug port first:
 *   POKEBOT_DEBUG_PORT=auto npm run dev      (bash)
 *   $env:POKEBOT_DEBUG_PORT='auto'; npm run dev   (PowerShell)
 *
 * Then:  node scripts/debug/watch-target.mjs [port]
 * With no port it discovers one from the Chromium profiles under %APPDATA%.
 */
import { chromium } from 'playwright-core'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE_ROOT = join(process.env.APPDATA || '', 'pokebot2', 'profiles')

function discoverPorts() {
  try {
    return readdirSync(PROFILE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          const raw = readFileSync(join(PROFILE_ROOT, entry.name, 'DevToolsActivePort'), 'utf8')
          const port = Number(raw.split(/\r?\n/)[0].trim())
          return Number.isInteger(port) && port > 0 ? port : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

const port = Number(process.argv[2]) || discoverPorts()[0]
if (!port) {
  console.error(
    `No debug port found under ${PROFILE_ROOT}.\n` +
      'Relaunch the app with POKEBOT_DEBUG_PORT=auto and try again.'
  )
  process.exit(1)
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const [context] = browser.contexts()
console.log(`attached on ${port}; ${context.pages().length} page(s)\n`)

const probe = async (page) =>
  page.evaluate(() => {
    const pick = (el) => (el ? el.outerHTML.slice(0, 500) : null)
    const trigger = document.querySelector(
      'button[class*="selectCustomButton"], button:has([class*="quantityValue"])'
    )
    const sheet = [...document.querySelectorAll('[role="dialog"],[role="alert"],[aria-live]')].find(
      (el) => /not added|something went wrong/i.test(el.innerText || '')
    )
    return {
      url: location.href,
      quantityTrigger: pick(trigger),
      quantityText: trigger?.innerText ?? null,
      // What the sheet really is decides whether :visible can ever match it.
      sheetTag: sheet ? `${sheet.tagName}[role=${sheet.getAttribute('role')}]` : null,
      sheetRect: sheet ? sheet.getBoundingClientRect().toJSON() : null,
      sheetHtml: pick(sheet),
      listbox: pick(document.querySelector('[role="listbox"]'))
    }
  })

for (const page of context.pages()) {
  if (!/target\.com/i.test(page.url())) continue
  console.log(JSON.stringify(await probe(page), null, 2))

  // Open the quantity dropdown so we capture the option markup we keep missing.
  const trigger = page.locator('button[class*="selectCustomButton"]').first()
  if (await trigger.count().catch(() => 0)) {
    await trigger.click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(400)
    console.log('--- after opening the dropdown ---')
    console.log(JSON.stringify(await probe(page), null, 2))
  }
}

await browser.close()
