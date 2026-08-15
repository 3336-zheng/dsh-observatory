import { expect, test } from '@playwright/test'

test('工作台在目标视口内完整渲染', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('observatory-workbench')).toBeVisible()
  await expect(page.getByText('Observatory MVP · runtime inspection')).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  expect(overflow).toBe(false)
})
