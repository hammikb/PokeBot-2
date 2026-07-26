import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const artifactDirectories = ['dist', 'out', 'output', 'coverage']

for (const directory of artifactDirectories) {
  const target = resolve(projectRoot, directory)
  rmSync(target, { recursive: true, force: true })
  console.log(`Cleaned ${directory}`)
}
