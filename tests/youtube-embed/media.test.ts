import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import test from 'node:test';
import { create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { parseYouTubeVideoLocator, youtubeEmbedUrl } from '../../shared/youtube.js';
import PostCard from '../../src/components/PostCard.js';
import WorldCard, { ExternalVideoMedia } from '../../src/components/WorldCard.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VIDEO = 'abcDEF_1234';
const capabilities = {
  imageUploads: { enabled: true }, avatarUploads: { enabled: true },
  externalVideoEmbeds: { enabled: true }, directVideoUploads: { enabled: false },
};
const videoItem = {
  id: 1, itemType: 'video', mediaProvider: 'youtube', videoId: VIDEO,
  title: 'Safe video', sourceName: 'Source', sourceCategory: 'video',
  linkUrl: `https://www.youtube.com/watch?v=${VIDEO}`, publishedAt: '2026-09-17T12:00:00Z',
};

test('external video iframe is canonical, privacy-enhanced, identified, and capability-gated', () => {
  const view = create(React.createElement(ExternalVideoMedia, {
    item: videoItem, capabilityState: 'loaded', capabilities,
  }));
  const iframe = view.root.findByType('iframe');
  assert.equal(iframe.props.src, `https://www.youtube-nocookie.com/embed/${VIDEO}`);
  assert.equal(iframe.props.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.notEqual(iframe.props.referrerPolicy, 'no-referrer');

  const disabled = create(React.createElement(ExternalVideoMedia, {
    item: videoItem, capabilityState: 'loaded',
    capabilities: { ...capabilities, externalVideoEmbeds: { enabled: false, reason: 'Unavailable.' } },
  }));
  assert.equal(disabled.root.findAllByType('iframe').length, 0);
  assert.match(JSON.stringify(disabled.toJSON()), /Unavailable/);
});

test('only validated YouTube identity can construct an iframe URL', () => {
  assert.equal(youtubeEmbedUrl(VIDEO), `https://www.youtube-nocookie.com/embed/${VIDEO}`);
  assert.equal(parseYouTubeVideoLocator(`https://www.youtube.com/embed/${VIDEO}`), VIDEO);
  assert.equal(parseYouTubeVideoLocator(`https://www.youtube-nocookie.com/embed/${VIDEO}`), VIDEO);
  assert.equal(parseYouTubeVideoLocator(`https://youtu.be/${VIDEO}`), VIDEO);
  for (const unsafe of [
    'https://evil.example/embed/abcDEF_1234',
    'javascript:alert(1)',
    'https://www.youtube-nocookie.com/embed/not-valid',
    `https://www.youtube-nocookie.com.evil.example/embed/${VIDEO}`,
    `http://www.youtube.com/embed/${VIDEO}`,
  ]) assert.equal(parseYouTubeVideoLocator(unsafe), null, unsafe);
  assert.throws(() => youtubeEmbedUrl('not-valid'));
});

test('post videos canonicalize legacy URLs and retain a safe YouTube fallback', () => {
  const post = {
    id: 7, userId: 3, username: 'author', displayName: 'Author', content: 'Video',
    createdAt: '2026-09-17 12:00:00', commentCount: 0,
    media: [{ id: 4, media_type: 'external_video', url: `https://www.youtube.com/embed/${VIDEO}` }],
  };
  const view = create(React.createElement(MemoryRouter, {}, React.createElement(PostCard, {
    post, currentUser: { id: 2, is_verified: 1 }, onMutation() {},
  })));
  const iframe = view.root.findByType('iframe');
  assert.equal(iframe.props.src, `https://www.youtube-nocookie.com/embed/${VIDEO}`);
  assert.equal(iframe.props.referrerPolicy, 'strict-origin-when-cross-origin');
  const fallback = view.root.findAllByType('a').find(node => node.children.join('') === 'Watch on YouTube');
  assert.equal(fallback?.props.href, `https://www.youtube.com/watch?v=${VIDEO}`);

  const unsafe = create(React.createElement(MemoryRouter, {}, React.createElement(PostCard, {
    post: { ...post, media: [{ id: 5, media_type: 'external_video', url: 'https://evil.example/embed/x' }] },
    currentUser: { id: 2, is_verified: 1 }, onMutation() {},
  })));
  assert.equal(unsafe.root.findAllByType('iframe').length, 0);
});

test('World card fallback and non-YouTube podcast media remain unchanged', () => {
  const video = create(React.createElement(WorldCard, { item: videoItem, capabilities, capabilityState: 'loaded' }));
  assert.ok(video.root.findAllByType('a').some(node => node.children.join('').includes('Open original')));

  const podcast = create(React.createElement(WorldCard, {
    item: { id: 2, itemType: 'podcast', title: 'Episode', sourceName: 'Podcast', sourceCategory: 'audio',
      linkUrl: 'https://podcast.example/episode', enclosureUrl: 'https://podcast.example/audio.mp3',
      enclosureType: 'audio/mpeg', publishedAt: '2026-09-17T12:00:00Z' },
  }));
  assert.equal(podcast.root.findAllByType('audio').length, 1);
  assert.equal(podcast.root.findAllByType('iframe').length, 0);
});

test('document and iframe sizing declarations preserve origin-only referrers and player minimums', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src/styles/index.css'), 'utf8');
  assert.match(html, /name="referrer" content="strict-origin-when-cross-origin"/);
  assert.doesNotMatch(html, /no-referrer/);
  assert.match(css, /\.world-video-media iframe[^}]*min-height:\s*200px[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
  assert.match(css, /\.post-video-wrap[^}]*min-width:\s*200px[^}]*min-height:\s*200px[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
});
