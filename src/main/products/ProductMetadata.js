export function estimatePokemonMsrp(name) {
  const normalized = String(name).toLowerCase()
  if (!/pok[eé]mon|pokemon|tcg|trading card/.test(normalized)) return null
  if (/booster display|booster box/.test(normalized)) return 161.64
  if (
    /mega evolution.*elite trainer box|elite trainer box.*mega evolution|chaos rising.*elite trainer box/.test(
      normalized
    )
  )
    return 59.99
  if (/elite trainer box| etb/.test(normalized)) return 49.99
  if (/booster bundle/.test(normalized)) return 26.94
  if (/3-pack|three pack|blister/.test(normalized)) return 14.99
  if (/mini tin/.test(normalized)) return 9.99
  if (/\btin\b/.test(normalized)) return 24.99
  if (/premium collection/.test(normalized)) return 39.99
  if (/collection box|ex box/.test(normalized)) return 21.99
  if (/booster pack|sleeved booster|single pack/.test(normalized)) return 4.49
  return null
}

export function formatMoney(value) {
  return value == null ? null : `$${Number(value).toFixed(2)}`
}
