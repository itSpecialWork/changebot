import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'support-bot/tests/**/*.test.ts'],
    clearMocks: true,
  },
});
