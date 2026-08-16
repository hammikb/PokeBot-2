import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: {
    jsx: 'automatic'
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globals: true,
    passWithNoTests: true
  }
})
