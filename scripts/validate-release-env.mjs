const required = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'GH_TOKEN']
const missing = required.filter((name) => !String(process.env[name] || '').trim())

if (missing.length) {
  console.error(`Signed Windows release blocked. Missing: ${missing.join(', ')}`)
  process.exit(1)
}

console.log('Release signing and GitHub publishing credentials are configured.')
