import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import http from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';

let browser: Browser;
let server: http.Server;
let origin: string;
before(async () => {
  const bundle = await build({ entryPoints: [path.resolve('tests/batch13/browser-fixture.tsx')], bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' } });
  const script = bundle.outputFiles[0].text;
  server = http.createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(script); }
    else if (req.url === '/fixture.png') { res.setHeader('content-type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')); }
    else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html lang="en"><head><title>Isolated Batch 13 fixture</title><style>dialog{max-width:500px} img{max-width:80px} dialog::backdrop{background:#0008}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  browser = await chromium.launch({ executablePath: process.env.BATCH13_CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });

async function fixture(mode: string, run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  try {
    await page.goto(`${origin}/?mode=${mode}`);
    await run(page);
    assert.equal(await page.evaluate(() => (window as any).fixture.nativeCalls), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}
async function calls(page: Page) { return page.evaluate(() => (window as any).fixture.calls); }

test('native DOM dialog names/describes itself, contains keyboard focus, blocks background, cancels without mutation and restores focus', async () => {
  await fixture('dialog', async page => {
    const trigger = page.getByRole('button', { name: 'Open deletion', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Delete fixture', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.match(await dialog.getAttribute('aria-describedby') || '', /description/);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Delete permanently');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
    await page.evaluate(() => document.getElementById('background')!.focus());
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'background');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog').count(), 0);
    assert.equal(await calls(page), 0);
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    await trigger.click();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await calls(page), 0);
  });
});

test('pending duplicate/rapid confirmations fire once, Escape cannot cancel in-flight work, failures remain retryable', async () => {
  await fixture('dialog', async page => {
    await page.evaluate(() => { Object.assign((window as any).fixture, { fail: true, pending: true }); });
    await page.getByRole('button', { name: 'Open deletion', exact: true }).click();
    const confirm = page.getByRole('button', { name: 'Delete permanently', exact: true });
    await confirm.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); button.click(); });
    assert.equal(await calls(page), 1);
    assert.equal(await confirm.isDisabled(), true);
    await page.getByRole('status').waitFor();
    assert.equal(await page.evaluate(() => document.querySelector('dialog')!.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await page.evaluate(() => (window as any).fixture.release());
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('alert').textContent(), 'Controlled request failure');
    await page.evaluate(() => { Object.assign((window as any).fixture, { fail: false, pending: false }); });
    await confirm.click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    assert.equal(await calls(page), 2);
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Open deletion');
  });
});

test('typed confirmation requires exact text and Enter in its input cannot activate deletion', async () => {
  await fixture('dialog', async page => {
    await page.getByRole('button', { name: 'Open strong deletion' }).click();
    const confirm = page.getByRole('button', { name: 'Delete permanently' });
    assert.equal(await confirm.isDisabled(), true);
    await page.getByRole('textbox').fill('exact');
    assert.equal(await confirm.isDisabled(), true);
    await page.getByRole('textbox').fill('EXACT');
    await page.keyboard.press('Enter');
    assert.equal(await calls(page), 0);
    await confirm.click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    assert.equal(await calls(page), 1);
  });
});

test('real PostCard delete cancels, preserves failed entities, then reconciles duplicate/nested copies after success', async () => {
  await fixture('post', async page => {
    const trigger = () => page.getByRole('button', { name: 'Delete post', exact: true }).first();
    await trigger().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await calls(page), 0);
    assert.equal(await page.locator('.post-content').count(), 3);
    await page.evaluate(() => { (window as any).fixture.fail = true; });
    await trigger().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete post', exact: true }).click();
    await page.getByRole('dialog').getByRole('alert').waitFor();
    assert.equal(await page.locator('.post-content').count(), 3);
    await page.evaluate(() => { (window as any).fixture.fail = false; });
    await page.getByRole('dialog').getByRole('button', { name: 'Delete post', exact: true }).click();
    await page.locator('.post-card').first().waitFor({ state: 'detached' });
    assert.equal(await page.locator('.post-card').count(), 0);
    assert.equal(await calls(page), 2);
  });
});

test('real group deletion retains exact-name safeguard, cancellation and recoverable server failure', async () => {
  await fixture('group', async page => {
    const trigger = page.getByRole('button', { name: 'Delete group…', exact: true });
    await trigger.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await calls(page), 0);
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Delete group', exact: true });
    const confirm = dialog.getByRole('button', { name: 'Delete group permanently' });
    assert.equal(await confirm.isDisabled(), true);
    assert.match(await dialog.textContent() || '', /including posts by other members/);
    await dialog.getByRole('textbox').fill('Exact Group Name');
    await page.evaluate(() => { (window as any).fixture.fail = true; });
    await confirm.click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await dialog.getByRole('textbox').inputValue(), 'Exact Group Name');
    await page.evaluate(() => { (window as any).fixture.fail = false; });
    await confirm.click();
    await page.getByText('Group list', { exact: true }).waitFor();
    assert.equal(await calls(page), 2);
  });
});

test('PostCard repost retains pending state, blocks rapid duplicate submission and reconciles only after a successful retry', async () => {
  await fixture('post', async page => {
    const trigger = page.getByRole('button', { name: 'Repost', exact: true }).first();
    await page.evaluate(() => Object.assign((window as any).fixture, { fail: true, pending: true }));
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Share this post?' });
    const share = dialog.getByRole('button', { name: 'Share', exact: true });
    await share.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    assert.equal(await calls(page), 1);
    assert.equal(await trigger.isDisabled(), true);
    assert.equal(await share.isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Cancel' }).isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true);
    await page.evaluate(() => (window as any).fixture.release());
    await dialog.getByRole('alert').waitFor();
    assert.equal(await trigger.textContent(), '🔄 0');
    assert.equal(await share.isDisabled(), false);
    await page.evaluate(() => Object.assign((window as any).fixture, { fail: false, pending: false }));
    await share.click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await calls(page), 2);
    assert.equal(await trigger.isDisabled(), false);
    assert.equal(await trigger.textContent(), '🔄 1');
    assert.equal(await page.getByText('Repost failed', { exact: true }).count(), 0);
  });
});

test('PostCard reports preserve validation, draft, pending/error and submission state across failure and retry', async () => {
  await fixture('post', async page => {
    await page.getByRole('button', { name: 'Report post', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Report this post' });
    const submit = dialog.getByRole('button', { name: 'Submit Report', exact: true });
    await submit.click();
    await dialog.getByRole('alert').waitFor();
    assert.match(await dialog.getByRole('alert').textContent() || '', /select a reason/);
    assert.equal(await calls(page), 0);
    const details = dialog.getByRole('textbox', { name: 'Details', exact: true });
    await details.fill('A specific reason\nwith context');
    await page.evaluate(() => Object.assign((window as any).fixture, { fail: true, pending: true }));
    await submit.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    assert.equal(await calls(page), 1);
    assert.equal(await details.isDisabled(), true);
    assert.equal(await submit.isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true);
    await page.evaluate(() => (window as any).fixture.release());
    await dialog.getByRole('alert').filter({ hasText: 'Controlled request failure' }).waitFor();
    assert.equal(await details.inputValue(), 'A specific reason\nwith context');
    assert.equal(await details.isDisabled(), false);
    assert.equal(await page.getByText('Report submitted. Thank you.', { exact: true }).count(), 0);
    await page.evaluate(() => Object.assign((window as any).fixture, { fail: false, pending: false }));
    await submit.click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('status').filter({ hasText: 'Report submitted. Thank you.' }).waitFor();
    assert.equal(await calls(page), 2);
  });
});

test('description editing renders plain alt, preserves drafts, reconciles nested copies and survives stale text saves', async () => {
  await fixture('post', async page => {
    await page.getByRole('button', { name: 'Edit image description' }).first().click();
    const draft = page.getByRole('textbox', { name: 'Image description', exact: true });
    await draft.fill('<b>Fox & snow</b>');
    await page.evaluate(() => { (window as any).fixture.fail = true; });
    await page.getByRole('button', { name: 'Save description', exact: true }).click();
    await page.getByRole('alert').first().waitFor();
    assert.equal(await draft.inputValue(), '<b>Fox & snow</b>');
    assert.deepEqual(await page.locator('.post-media-img').evaluateAll(images => images.map(img => img.getAttribute('alt'))), ['A fox in snow','A fox in snow','A fox in snow']);
    await page.evaluate(() => { (window as any).fixture.fail = false; });
    await page.getByRole('button', { name: 'Save description', exact: true }).click();
    await draft.waitFor({ state: 'detached' });
    assert.deepEqual(await page.locator('.post-media-img').evaluateAll(images => images.map(img => img.getAttribute('alt'))), Array(3).fill('<b>Fox & snow</b>'));
    assert.equal(await page.locator('.post-media-wrap b').count(), 0);
    assert.deepEqual(await page.locator('.avatar-img').evaluateAll(images => images.map(img => img.getAttribute('alt'))), Array(3).fill(''));
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Preserved stale text draft');
    await page.evaluate(() => { (window as any).fixture.textConflict = true; });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(/This post changed in another window/).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Edit text', exact: true }).inputValue(), 'Preserved stale text draft');
    assert.equal(await page.locator('.post-media-img').first().getAttribute('alt'), '<b>Fox & snow</b>');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Edit image description' }).first().click();
    await draft.fill('');
    await page.getByRole('button', { name: 'Save description', exact: true }).click();
    await draft.waitFor({ state: 'detached' });
    assert.deepEqual(await page.locator('.post-media-img').evaluateAll(images => images.map(img => img.getAttribute('alt'))), ['', '', '']);
    assert.equal(await page.getByRole('button', { name: 'Choose reaction' }).count(), 4);
  });
});

for (const mode of ['home', 'composer']) test(`${mode} image composer authors descriptions and retries with stable owned asset and post identity`, async () => {
  await fixture(mode, async page => {
    await page.locator('input[type=file]').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: Buffer.from('fixture-upload-bytes') });
    await page.getByRole('textbox', { name: 'Image description', exact: true }).fill('A fox in a public group');
    assert.equal(await page.locator('.image-preview').getAttribute('alt'), 'A fox in a public group');
    await page.evaluate(() => { (window as any).fixture.fail = true; });
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await page.getByRole('textbox', { name: 'Image description', exact: true }).fill('Revised before successful attachment');
    await page.evaluate(() => { (window as any).fixture.fail = false; });
    await page.getByRole('button', { name: /Retry (image )?attachment/ }).click();
    await page.getByRole('textbox', { name: 'Image description', exact: true }).waitFor({ state: 'detached' });
    const state = await page.evaluate(() => (window as any).fixture);
    assert.equal(state.creates, 1); assert.equal(state.uploads, 1);
    assert.equal(state.attachments.length, 2);
    assert.equal(state.attachments[0].assetId, state.attachments[1].assetId);
    assert.equal(state.attachments[0].postId, state.attachments[1].postId);
    assert.equal(state.attachments[1].altText, 'Revised before successful attachment');
  });
});
