import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Tests must never reach real external services.
    env: {
      OPENAI_API_KEY: '',
      TELEGRAM_BOT_TOKEN: '',
    },
  },
});
