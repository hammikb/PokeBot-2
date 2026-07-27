import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const tracked = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' }
)
  .split('\0')
  .filter(Boolean)
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => existsSync(file))
const trackedSet = new Set(tracked)
const trackedDirectories = new Set()

for (const file of tracked) {
  let directory = path.posix.dirname(file)
  while (directory && directory !== '.') {
    trackedDirectories.add(directory)
    directory = path.posix.dirname(directory)
  }
}

const failures = []
const forbiddenTrackedFile = [
  { pattern: /^(?:dist(?:-[^/]+)?|out|output|coverage)\//, label: 'generated build output' },
  { pattern: /(?:^|\/)__pycache__\//, label: 'Python bytecode cache' },
  { pattern: /\.pyc$/i, label: 'Python bytecode' },
  { pattern: /(?:^|\/)\.env$/i, label: 'private environment file' },
  { pattern: /\.(?:db|sqlite|sqlite3)(?:-|$)/i, label: 'local database' },
  { pattern: /\.log(?:\.|$)/i, label: 'runtime log' }
]

for (const file of tracked) {
  const forbidden = forbiddenTrackedFile.find(({ pattern }) => pattern.test(file))
  if (forbidden) failures.push(`${file}: tracked ${forbidden.label}`)

  if (/^docs\/[^/]+$/.test(file) && file !== 'docs/README.md') {
    failures.push(`${file}: documentation must be filed under guides, reference, or roadmaps`)
  }
}

const requiredIndexes = [
  'docs/README.md',
  'scripts/README.md',
  'src/main/README.md',
  'src/renderer/README.md',
  'tests/README.md'
]
for (const file of requiredIndexes) {
  if (!trackedSet.has(file)) failures.push(`${file}: required directory index is missing`)
}

const markdownFiles = tracked.filter((file) => file.endsWith('.md'))
for (const file of markdownFiles) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '')
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue
    target = target.split('#')[0]
    if (!target) continue
    try {
      target = decodeURIComponent(target)
    } catch {
      failures.push(`${file}: invalid encoded Markdown link ${match[1]}`)
      continue
    }
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(file), target))
      .replace(/\/+$/, '')
    if (!trackedSet.has(resolved) && !trackedDirectories.has(resolved)) {
      failures.push(`${file}: broken local Markdown link ${match[1]}`)
    }
  }
}

for (const file of tracked.filter(
  (entry) => entry.startsWith('src/') && /\.(?:js|jsx)$/.test(entry)
)) {
  if (file.startsWith('src/main/experimental/')) continue
  const text = readFileSync(file, 'utf8')
  if (/from\s+['"][^'"]*experimental\//.test(text)) {
    failures.push(`${file}: production source imports an experimental module`)
  }
}

if (failures.length) {
  console.error('Repository structure check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log(
  `Repository structure is organized: ${tracked.length} repository files and ${markdownFiles.length} Markdown files checked.`
)
