const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="captcha"]',
  '[class*="captcha"]',
  '#challenge-form',
  '[data-sitekey]'
]

async function isCaptchaPresent(page) {
  try {
    const presentInMainDocument = await page.evaluate((selectors) => {
      const pageText = document.body?.innerText?.toLowerCase() || ''
      return (
        selectors.some((sel) => !!document.querySelector(sel)) ||
        document.title.toLowerCase().includes('captcha') ||
        document.title.toLowerCase().includes('robot') ||
        document.title.toLowerCase().includes('access denied') ||
        pageText.includes('robot or human?') ||
        pageText.includes('activate and hold the button to confirm that you')
      )
    }, CAPTCHA_SELECTORS)
    if (presentInMainDocument) return true
  } catch {
    // Cross-origin challenge frames may not be readable from the main document.
  }

  try {
    return (page.frames?.() || []).some((frame) =>
      /(?:captcha|challenge|recaptcha|hcaptcha)/i.test(String(frame.url?.() || ''))
    )
  } catch {
    return false
  }
}

async function detectCaptchaConfig(page) {
  return await page.evaluate(() => {
    const recaptcha = document.querySelector('[data-sitekey]');
    if (recaptcha) {
      const sitekey = recaptcha.getAttribute('data-sitekey');
      const isV3 = document.querySelector('.g-recaptcha[data-sitekey]')?.getAttribute('data-size') === 'invisible';
      return { type: isV3 ? 'ReCaptchaV3TaskProxyLess' : 'ReCaptchaV2TaskProxyLess', sitekey };
    }
    const hcaptcha = document.querySelector('[data-sitekey][data-theme]');
    if (hcaptcha) {
      return { type: 'HCaptchaTaskProxyLess', sitekey: hcaptcha.getAttribute('data-sitekey') };
    }
    if (document.querySelector('[data-sitekey][data-cf-turnstile]')) {
      return { type: 'AntiCloudflareTask', sitekey: document.querySelector('[data-sitekey]').getAttribute('data-sitekey') };
    }
    return null;
  });
}

async function solveCaptchaWithCapsolver(page, apiKey, notificationEngine, dropEvent) {
  const config = await detectCaptchaConfig(page);
  if (!config) {
    console.log('No CAPTCHA widget found to solve.');
    return false;
  }

  console.log(`Solving ${config.type} with sitekey ${config.sitekey}`);
  const task = {
    type: config.type,
    websiteURL: page.url(),
    websiteKey: config.sitekey
  };

  const response = await fetch('https://api.capsolver.com/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientKey: apiKey,
      task: task
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.description || data.error);

  const token = data.solution?.gRecaptchaResponse || data.solution?.token;
  if (!token) throw new Error('No token returned from CapSolver');

  await page.evaluate((t) => {
    const responseEl = document.getElementById('g-recaptcha-response');
    if (responseEl) {
      responseEl.value = t;
      responseEl.innerHTML = t;
    }
    if (typeof window.onSuccess === 'function') window.onSuccess(t);
    if (typeof window.___grecaptcha_cfg !== 'undefined') {
      for (const k in window.___grecaptcha_cfg.clients) {
        if (window.___grecaptcha_cfg.clients[k]?.callback) {
          window.___grecaptcha_cfg.clients[k].callback(t);
        }
      }
    }
    const hcaptchaWidget = document.querySelector('[data-sitekey]');
    if (hcaptchaWidget) hcaptchaWidget.dispatchEvent(new Event('change', { bubbles: true }));
  }, token);

  if (notificationEngine) {
    await notificationEngine.fire({
      ...dropEvent,
      productName: `CAPTCHA SOLVED: ${dropEvent?.productName || 'Unknown'}`,
      dropType: 'captcha-solved'
    });
  }
  return true;
}

export async function waitForCaptchaIfNeeded(page, notificationEngine, dropEvent, capsolverApiKey = null) {
  const hasCaptcha = await isCaptchaPresent(page);
  if (!hasCaptcha) return;

  if (capsolverApiKey) {
    try {
      const solved = await solveCaptchaWithCapsolver(page, capsolverApiKey, notificationEngine, dropEvent);
      if (solved) {
        await new Promise(r => setTimeout(r, 2000));
        const stillPresent = await isCaptchaPresent(page);
        if (!stillPresent) return;
      }
    } catch (error) {
      console.error('CapSolver auto-solve failed, falling back to manual:', error.message);
    }
  }

  // Manual fallback (existing behavior)
  await notificationEngine.fire({
    ...dropEvent,
    productName: `CAPTCHA REQUIRED (Manual): ${dropEvent.productName || 'Unknown'}`,
    dropType: 'captcha'
  });

  try {
    await page.waitForFunction(
      (selectors) => {
        const pageText = document.body?.innerText?.toLowerCase() || ''
        return (
          !selectors.some((sel) => !!document.querySelector(sel)) &&
          !document.title.toLowerCase().includes('captcha') &&
          !document.title.toLowerCase().includes('robot') &&
          !document.title.toLowerCase().includes('access denied') &&
          !pageText.includes('robot or human?') &&
          !pageText.includes('activate and hold the button to confirm that you')
        )
      },
      CAPTCHA_SELECTORS,
      { timeout: 300000, polling: 2000 }
    )
  } catch {
    // Timeout
  }
}
