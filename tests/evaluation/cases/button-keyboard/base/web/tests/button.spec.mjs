import { test, expect } from '@playwright/test';
test('button label', async ({page}) => {
  await page.goto('/button');
  await expect(page.locator('.button')).toHaveText('Save');
});
