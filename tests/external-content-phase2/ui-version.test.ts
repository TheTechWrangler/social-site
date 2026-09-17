import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import test from 'node:test';
import { create } from 'react-test-renderer';
import { ExternalVideoMedia } from '../../src/components/WorldCard.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VIDEO = 'abcDEF_1234';
const item = {
  itemType: 'video', mediaProvider: 'youtube', videoId: VIDEO, title: 'Safe video',
  imageUrl: `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`, linkUrl: `https://www.youtube.com/watch?v=${VIDEO}`,
};

function serialized(element: React.ReactElement): string {
  return JSON.stringify(create(element).toJSON());
}

test('video cards embed only validated YouTube IDs when authoritative capability is enabled', () => {
  const output = serialized(React.createElement(ExternalVideoMedia, {
    item, capabilityState: 'loaded', capabilities: {
      imageUploads: { enabled: true }, avatarUploads: { enabled: true },
      externalVideoEmbeds: { enabled: true }, directVideoUploads: { enabled: false },
    },
  }));
  assert.match(output, new RegExp(`youtube-nocookie\\.com/embed/${VIDEO}`));
  assert.doesNotMatch(output, /youtube\.com\/feeds|iframe.*evil/i);
});

test('disabled embed capability retains safe thumbnail/link content with truthful fallback', () => {
  const output = serialized(React.createElement(ExternalVideoMedia, {
    item, capabilityState: 'loaded', capabilities: {
      imageUploads: { enabled: true }, avatarUploads: { enabled: true },
      externalVideoEmbeds: { enabled: false, reason: 'Embedded video is disabled.' }, directVideoUploads: { enabled: false },
    },
  }));
  assert.match(output, /i\.ytimg\.com/);
  assert.match(output, /Embedded video is disabled/);
  assert.doesNotMatch(output, /iframe/);
});

test('capability failure fails closed for embedding and explains the external-link fallback', () => {
  const output = serialized(React.createElement(ExternalVideoMedia, { item, capabilityState: 'error', capabilities: null }));
  assert.match(output, /could not be confirmed/);
  assert.doesNotMatch(output, /iframe/);
});

test('invalid provider video identity never becomes an iframe source', () => {
  const output = serialized(React.createElement(ExternalVideoMedia, {
    item: { ...item, videoId: 'bad"><script>', imageUrl: '' }, capabilityState: 'loaded', capabilities: {
      imageUploads: { enabled: true }, avatarUploads: { enabled: true },
      externalVideoEmbeds: { enabled: true }, directVideoUploads: { enabled: false },
    },
  }));
  assert.doesNotMatch(output, /iframe|script/);
});

test('World and Admin expose the bounded submission/review workflow without playlist or direct-upload UI', () => {
  const world = fs.readFileSync(path.join(ROOT, 'src/pages/WorldPage.tsx'), 'utf8');
  const admin = fs.readFileSync(path.join(ROOT, 'src/pages/AdminPage.tsx'), 'utf8');
  assert.match(world, /Submit a feed/);
  assert.match(world, /does not fetch it until an admin reviews it/);
  assert.match(world, /sourceKind.*youtube_channel/s);
  assert.match(admin, /Submitted feeds/);
  assert.match(admin, /reviewSourceSubmission/);
  assert.doesNotMatch(world + admin, /youtube_playlist|YouTube playlist|direct video upload/i);
});

test('submission creation path contains no outbound network or source-ingestion call', () => {
  const service = fs.readFileSync(path.join(ROOT, 'server/sourceSubmissions.ts'), 'utf8');
  const creation = service.slice(service.indexOf('export function createSourceSubmission'), service.indexOf('export function getOwnSourceSubmissions'));
  assert.doesNotMatch(creation, /downloadFeed|probeYouTube|fetch\(|https\.request|resolve\(|external_sources/);
  assert.match(creation, /external_source_submissions/);
});

test('release version is 0.2.0 in authoritative package metadata and System Health reads it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const adminRoute = fs.readFileSync(path.join(ROOT, 'server/routes/admin.ts'), 'utf8');
  assert.equal(pkg.version, '0.2.0');
  assert.equal(lock.version, '0.2.0');
  assert.equal(lock.packages[''].version, '0.2.0');
  assert.match(adminRoute, /pkg\.version/);
  assert.match(adminRoute, /appVersion.*APP_VERSION/s);
  const appVersionReferences = `${fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')}\n${fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')}`;
  assert.doesNotMatch(appVersionReferences, /"version": "0\.1\.0"/);
});

test('Phase 2 adds no API key, playlist adapter, or direct-video implementation', () => {
  const files = [
    'server/youtubeService.ts', 'server/routes/sourceSubmissions.ts', 'server/sourceSubmissions.ts',
    'shared/youtube.ts', 'server/externalContentPhase2Migration.ts',
  ].map(file => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  assert.doesNotMatch(files, /YOUTUBE_API_KEY|googleapis|youtube_playlist|playlistItems|videos\.insert/);
  assert.doesNotMatch(files, /directVideoUploads|\/uploads\/video/);
});

test('safe diagnostics and operational audit do not record proposal or provider content', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'server/routes/sourceSubmissions.ts'), 'utf8');
  const service = fs.readFileSync(path.join(ROOT, 'server/sourceSubmissions.ts'), 'utf8');
  assert.doesNotMatch(routes, /logSafeDiagnostic\([^)]*(locator|channelId|videoId|note|title)/s);
  assert.match(service, /auditOperation\(db, 'external_source_submission\.(approve|reject)', adminId, 'external_source_submission', submissionId\)/);
});
