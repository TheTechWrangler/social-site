import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { attachComposerMedia, createClientOperationKey, SubmissionLock, submitComposerPost } from '../postComposerSubmission';
import ImageDescription from './ImageDescription';

export default function GroupPostComposer({ groupId, onCreated }: { groupId: number; onCreated: () => Promise<unknown> }) {
  const [content, setContent] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [imageAltText, setImageAltText] = useState('');
  const [imageAssetId, setImageAssetId] = useState<string | null>(null);
  const [postId, setPostId] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(createClientOperationKey());
  const lock = useRef(new SubmissionLock());
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const url = imageFile ? URL.createObjectURL(imageFile) : '';
    setPreview(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [imageFile]);
  async function submit() {
    if ((!content.trim() && !imageFile && !postId) || !lock.current.tryAcquire()) return;
    setPending(true); setError('');
    const dependencies = { uploadImage: api.uploadImage, attachImage: api.attachImage, attachYouTube: api.attachYouTube,
      createPost: (text: string, submissionKey: string) => api.createPost(text, groupId, submissionKey) };
    try {
      const draft = { imageFile, imageAssetId, imageAltText, youtubeUrl: '' };
      const result = postId ? await attachComposerMedia(postId, draft, dependencies)
        : await submitComposerPost(content, draft, key.current, dependencies);
      if (!mounted.current) return;
      setImageAssetId(result.imageAssetId);
      if (result.failures.length) {
        setPostId(result.postId);
        setError(`Post #${result.postId} was created, but its image could not be attached. Retry attaches to that same post.`);
      } else {
        setContent(''); setImageFile(null); setImageAltText(''); setPostId(null);
        key.current = createClientOperationKey();
        if (fileInput.current) fileInput.current.value = '';
        await onCreated();
      }
    } catch (failure: any) {
      if (mounted.current) setError(failure.message || 'Could not post. Your draft was preserved.');
    } finally {
      lock.current.release();
      if (mounted.current) setPending(false);
    }
  }
  return <form className="post-composer" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="muted">Public group — posts here may be visible to people who cannot view your private profile.</p>
    <label>Post text<textarea className="input" value={content} disabled={pending || postId !== null} rows={3}
      onChange={event => { setContent(event.target.value); key.current = createClientOperationKey(); }} /></label>
    <label>Attach image<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/gif,image/webp" disabled={pending || postId !== null}
      onChange={event => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!['jpg','jpeg','png','gif','webp'].includes(file.name.split('.').pop()?.toLowerCase() || '') || file.size > 5 * 1024 * 1024) {
          setError('Choose a JPG, PNG, GIF, or WebP image under 5MB.'); event.target.value = ''; return;
        }
        setError(''); setImageFile(file); setImageAssetId(null); setImageAltText(''); key.current = createClientOperationKey();
      }} /></label>
    {preview && <div className="image-preview-wrap">
      <img src={preview} alt={imageAltText} className="image-preview" />
      <ImageDescription value={imageAltText} onChange={setImageAltText} disabled={pending} />
      {postId === null && <button type="button" className="btn btn-sm" disabled={pending} onClick={() => {
        setImageFile(null); setImageAltText(''); if (fileInput.current) fileInput.current.value = '';
      }}>Remove selected image</button>}
    </div>}
    {error && <p className="error-msg" role="alert">{error}</p>}
    <button className="btn btn-primary" disabled={pending || (!content.trim() && !imageFile && !postId)}>
      {pending ? 'Posting…' : postId ? 'Retry image attachment' : 'Post'}
    </button>
    {postId && <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => void onCreated()}>Keep post without image</button>}
  </form>;
}
