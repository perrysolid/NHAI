import {test, expect} from '@playwright/test';

/**
 * E2E smoke + flow tests using Chromium's fake camera. The synthetic stream has
 * no real face, so we don't assert recognition here; we DO assert that:
 *  - the production build loads with no page errors
 *  - the face-api models actually load in the browser (proves assets + wiring)
 *  - the camera (fake) starts and the UI renders
 *  - input guards work (enroll needs an id, verify needs an enrollment)
 *  - the sync → purge lifecycle works against a seeded queue
 */

test('loads, initializes models, and renders the UI without errors', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('/');
  await expect(page).toHaveTitle(/DatalakeFaceAuth/);
  await expect(page.getByText('DatalakeFaceAuth').first()).toBeVisible();
  await expect(page.getByTestId('camera-video')).toBeVisible();

  // Proves the ~7MB face-api models are served and load in-browser.
  await expect(page.getByTestId('log')).toContainText('Models loaded', {
    timeout: 60_000,
  });

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
});

test('enroll requires a user id', async ({page}) => {
  await page.goto('/');
  await expect(page.getByTestId('log')).toContainText('Models loaded', {
    timeout: 60_000,
  });
  await page.getByTestId('enroll').click();
  await expect(page.getByTestId('log')).toContainText('Enter a user ID');
});

test('verify requires an enrollment', async ({page}) => {
  await page.goto('/');
  await expect(page.getByTestId('log')).toContainText('Models loaded', {
    timeout: 60_000,
  });
  await page.getByTestId('verify').click();
  await expect(page.getByTestId('log')).toContainText('No enrolled users');
});

test('sync uploads the pending queue then purges it locally', async ({
  page,
}) => {
  // Seed one pending attendance record before the app reads localStorage.
  await page.addInitScript(() => {
    localStorage.setItem(
      'dfa.queue.v1',
      JSON.stringify([
        {
          userId: 'inspector_01',
          timestamp: Date.now(),
          livenessPassed: true,
          matchDistance: 0.31,
          deviceId: 'web-test',
          synced: false,
        },
      ]),
    );
  });

  await page.goto('/');
  await expect(page.getByText('Pending queue (1)')).toBeVisible();
  await expect(page.getByText('inspector_01')).toBeVisible();

  // mock sync is on by default → simulates a 200 then purges.
  await page.getByTestId('sync').click();

  await expect(page.getByText('Pending queue (0)')).toBeVisible();
  await expect(page.getByText('empty — all synced')).toBeVisible();
  await expect(page.getByTestId('log')).toContainText('purged');
});
