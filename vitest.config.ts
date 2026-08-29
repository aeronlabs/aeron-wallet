import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts', 'src/mcp.ts'],
      thresholds: { lines: 80, functions: 80, branches: 70 },
    },
  },
})
