import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useActionDialog } from '../../src/components/ActionDialog';
import PostCard from '../../src/components/PostCard';
import GroupPage from '../../src/pages/GroupPage';
import HomePage from '../../src/pages/HomePage';
import GroupPostComposer from '../../src/components/GroupPostComposer';
import { api, ApiError } from '../../src/api/client';
import { applyPostEntityMutation } from '../../src/postEntityState';

const state = { calls: 0, nativeCalls: 0, fail: false, pending: false, release: () => {}, attachments: [] as any[], uploads: 0, creates: 0, altEdits: 0, textConflict: false };
(window as any).fixture = state;
window.confirm = () => { state.nativeCalls++; throw new Error('Native confirmation invoked'); };
window.alert = () => { state.nativeCalls++; throw new Error('Native alert invoked'); };
async function action() {
  state.calls++;
  if (state.pending) await new Promise<void>(resolve => { state.release = resolve; });
  if (state.fail) throw new Error('Controlled request failure');
}
const user = { id: 3, username: 'author', display_name: 'Author', is_verified: 1, role: 'user' };
const initial = { id: 7, userId: 3, username: 'author', displayName: 'Author', avatarUrl: '/fixture.png', content: 'Original text',
  editVersion: 0, editedAt: null, canEdit: true, createdAt: '2026-09-11 10:00:00', commentCount: 0 };
const image = { id: 5, post_id: 7, media_type: 'image', url: '/fixture.png', alt_text: 'A fox in snow', canEditAlt: true };
api.getPostMedia = async () => ({ media: [image] });
api.getComments = async () => ({ comments: [] });
api.deletePost = action as any;
api.deleteGroup = action as any;
api.repost = async () => {
  await action();
  return { post: { id: 99, userId: user.id, repostOf: initial.id, repostedPost: initial } } as any;
};
api.reportContent = async () => { await action(); return { ok: true } as any; };
api.editImageDescription = async (id, altText) => {
  state.altEdits++;
  if (state.fail) throw new Error('Description save failed');
  return { media: { ...image, id, alt_text: altText.trim() } };
};
api.editPost = async (id, content, expectedEditVersion) => {
  if (state.textConflict) throw new ApiError('Text changed elsewhere', { kind: 'http', status: 409, data: { code: 'STALE_POST_EDIT' } });
  return { post: { ...initial, id, content, editVersion: expectedEditVersion + 1, editedAt: '2026-09-11 11:00:00' }, changed: true };
};
api.getGroup = async () => ({ group: { id: 8, name: 'Exact Group Name', owner_id: 3, memberCount: 1 }, members: [{ id: 3, role: 'admin', display_name: 'Author' }], posts: [] });
api.feed = async () => ({ posts: [], items: [] }) as any;
api.createPost = async () => { state.creates++; return { post: { id: 77 } } as any; };
api.uploadImage = async () => { state.uploads++; return { asset: { id: 'a'.repeat(32) } }; };
api.attachImage = async (assetId, postId, altText) => {
  state.attachments.push({ assetId, postId, altText });
  if (state.fail) throw new Error('Attachment failed');
  return { media: { ...image, alt_text: altText } };
};

function DialogFixture() {
  const { confirmAction, actionDialog } = useActionDialog('fixture');
  return <><button onClick={() => confirmAction({ title: 'Delete fixture', description: 'This permanently deletes the selected fixture.', confirmLabel: 'Delete permanently' }, action)}>Open deletion</button>
    <button onClick={() => confirmAction({ title: 'Strong deletion', description: 'Confirm the exact name.', confirmationText: 'EXACT', confirmLabel: 'Delete permanently' }, action)}>Open strong deletion</button>
    <button id="background">Background action</button>{actionDialog}</>;
}
function Cards() {
  const [posts, setPosts] = useState([initial, { ...initial }, { id: 9, userId: 4, repostOf: 7, repostedPost: initial }]);
  return <>{posts.map((post, index) => <PostCard key={index} post={post} currentUser={user}
    onMutation={mutation => setPosts(current => applyPostEntityMutation(current, mutation))} />)}</>;
}
const mode = new URLSearchParams(location.search).get('mode');
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/groups/8']}>
  {mode === 'post' ? <Cards /> : mode === 'group' ? <Routes><Route path="/groups/:id" element={<GroupPage user={user} />} /><Route path="/groups" element={<p>Group list</p>} /></Routes>
    : mode === 'home' ? <HomePage user={user} onUserChange={() => {}} />
    : mode === 'composer' ? <GroupPostComposer groupId={8} onCreated={async () => {}} /> : <DialogFixture />}
</MemoryRouter>);
