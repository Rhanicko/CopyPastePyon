process.env.DATABASE_URL = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;
const { createServer } = require('../server');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

test('browser host, share-link, connect, and end-share workflow is accessible', { timeout: 45_000 }, async () => {
  const { server, io } = createServer();
  await new Promise(resolve => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.platform === 'win32' && fs.existsSync(chromePath) ? chromePath : undefined, headless: true });
  try {
    const hostContext = await browser.newContext();
    const host = await hostContext.newPage();
    await host.goto(baseUrl);
    const landingA11y = await new AxeBuilder({ page: host }).analyze();
    assert.deepEqual(landingA11y.violations.filter(item => ['critical', 'serious'].includes(item.impact)), []);
    await host.getByRole('button', { name: 'Host a workspace' }).click();
    await host.getByLabel('Display name optional').fill('Rhanley');
    await host.getByRole('button', { name: 'Create workspace' }).click();
    const code = await host.locator('.workspace-code strong').textContent();
    assert.match(code, /^[A-Z0-9]{8}$/);
    await host.getByRole('button', { name: '+ New note' }).click();
    await host.locator('#note-title').fill('Python Student Logger');
    await host.locator('#note-content').evaluate(element => {
      const pasted = 'students=[]\n\ndef add_student(name):\n    students.append(name)';
      const transfer = new DataTransfer(); transfer.setData('text/plain', pasted);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
      element.value = pasted; element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await host.locator('#note-language').inputValue(), 'Python');
    assert.equal((await host.locator('#line-numbers').textContent()).split('\n').length, 4);
    const editorA11y = await new AxeBuilder({ page: host }).analyze();
    assert.deepEqual(editorA11y.violations.filter(item => ['critical', 'serious'].includes(item.impact)), []);
    await host.getByRole('button', { name: 'Save note' }).click();
    await host.getByText('Python Student Logger').first().waitFor();
    const workspaceA11y = await new AxeBuilder({ page: host }).analyze();
    assert.deepEqual(workspaceA11y.violations.filter(item => ['critical', 'serious'].includes(item.impact)), []);

    const guest = await (await browser.newContext()).newPage();
    await guest.goto(`${baseUrl}/?join=${code}`);
    await assert.doesNotReject(async () => guest.getByLabel('Workspace code').inputValue().then(value => assert.equal(value, code)));
    await guest.getByLabel('Display name optional').fill('Mark');
    await guest.getByRole('button', { name: 'Connect' }).click();
    await guest.getByText('Python Student Logger').first().waitFor();

    host.once('dialog', dialog => dialog.accept());
    await host.getByRole('button', { name: 'End share' }).click();
    await host.getByRole('button', { name: 'Host a workspace' }).waitFor();
    await guest.getByRole('button', { name: 'Host a workspace' }).waitFor();
  } finally {
    await browser.close();
    io.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('phone layout keeps the full host workspace accessible without horizontal overflow', { timeout: 45_000 }, async () => {
  const { server, io } = createServer();
  await new Promise(resolve => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.platform === 'win32' && fs.existsSync(chromePath) ? chromePath : undefined, headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
    await page.goto(baseUrl);
    await page.getByRole('button', { name: 'Host a workspace' }).click();
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.locator('.workspace-code strong').waitFor();
    await page.getByText('Workspace controls').click();
    await page.getByRole('button', { name: 'Regenerate code' }).waitFor();
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scrollWidth <= dimensions.width, `page overflowed horizontally: ${dimensions.scrollWidth}px > ${dimensions.width}px`);
    const accessibility = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(accessibility.violations.filter(item => ['critical', 'serious'].includes(item.impact)), []);
  } finally {
    await browser.close();
    io.close();
    await new Promise(resolve => server.close(resolve));
  }
});
