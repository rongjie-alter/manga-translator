import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  server: {
    // test-img/ is served from the project root in dev so the headless import
    // path can fetch sample pages without going through showDirectoryPicker().
    fs: { allow: ['.'] },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
