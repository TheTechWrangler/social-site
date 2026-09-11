import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { applyPostEntityMutation } from '../../src/postEntityState.js';
import { api, ApiError } from '../../src/api/client.js';

test('targeted production components cannot reintroduce native dialog calls (AST, ignoring comments and strings)', () => {
  const files = ['components/PostCard', ...['Profile','Group','Messages','World','Admin','Home','Friends','GameDetail'].map(name => `pages/${name}Page`)];
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(`src/${file}.tsx`, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression)) assert.ok(!['confirm','alert'].includes(expression.text), `${file}: native ${expression.text}`);
        if (ts.isPropertyAccessExpression(expression) && ['window','globalThis'].includes(expression.expression.getText(source))) {
          assert.ok(!['confirm','alert'].includes(expression.name.text), `${file}: native ${expression.name.text}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});

test('canonical media description edits propagate through duplicates, nested reposts/comments and survive late loads/text updates', () => {
  const image = { id: 11, alt_text: 'Before' };
  const post = { id: 1, content: 'Text', editVersion: 2, media: [image] };
  let posts = [post, { ...post, media: undefined }, { id: 2, repostedPost: post }, { id: 3, comments: [post] }];
  posts = applyPostEntityMutation(posts, { type: 'media-description', postId: 1, media: { ...image, alt_text: 'After' } });
  posts = applyPostEntityMutation(posts, { type: 'media-loaded', postId: 1, media: [image] });
  posts = applyPostEntityMutation(posts, { type: 'update', post: { id: 1, content: 'New text', editVersion: 3 } });
  for (const copy of [posts[0],posts[1],posts[2].repostedPost,posts[3].comments[0]]) {
    assert.equal(copy.media[0].alt_text, 'After');
    assert.equal(copy.content, 'New text');
  }
});

test('description client uses checked narrow PATCH and reports HTTP failures truthfully', async () => {
  const original = globalThis.fetch;
  try {
    let request: any;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ media: { id: 4, alt_text: '' } }), { status: 200 });
    };
    const result = await api.editImageDescription(4, '');
    assert.equal(result.media.alt_text, '');
    assert.equal(request.url, '/api/uploads/media/4/description');
    assert.equal(request.options.method, 'PATCH');
    assert.deepEqual(JSON.parse(request.options.body), { altText: '' });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Image not found.' }), { status: 404 });
    await assert.rejects(api.editImageDescription(4, 'Other'), error => error instanceof ApiError && error.status === 404);
  } finally { globalThis.fetch = original; }
});
