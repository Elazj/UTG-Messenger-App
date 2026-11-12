import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : undefined,
  },
});
