import { existsSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'

if (process.env.POKEBOT_SKIP_NATIVE_REBUILD === '1') {
  console.log('Skipping native dependency rebuild because POKEBOT_SKIP_NATIVE_REBUILD=1')
  process.exit(0)
}

const binName = process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
const electronBuilderBin = join(process.cwd(), 'node_modules', '.bin', binName)

if (!existsSync(electronBuilderBin)) {
  console.warn('Skipping native dependency rebuild because electron-builder is not installed yet.')
  process.exit(0)
}

const result = spawnSync(electronBuilderBin, ['install-app-deps'], {
  stdio: 'inherit',
  shell: false
})

if (result.status === 0) process.exit(0)

console.warn('')
console.warn(
  'Native dependency rebuild failed, but PokeBot can continue with the JSON database fallback.'
)
console.warn(
  'Install Visual Studio Build Tools and move the project to a path without spaces if you want better-sqlite3.'
)
process.exit(0)
