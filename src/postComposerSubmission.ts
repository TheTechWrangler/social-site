export type AttachmentKind = 'image' | 'video';

export interface AttachmentFailure {
  kind: AttachmentKind;
  error: unknown;
}

export interface AttachmentDraft {
  imageFile: File | null;
  youtubeUrl: string;
  imageAssetId?: string | null;
  imageAltText?: string;
  videoAttachmentKey?: string | null;
}

export interface ComposerDependencies {
  createPost: (content: string, submissionKey: string) => Promise<{ post: { id: number } }>;
  uploadImage: (file: File) => Promise<{ asset: { id: string } }>;
  attachImage: (assetId: string, postId: number, altText?: string) => Promise<unknown>;
  attachYouTube: (url: string, postId: number, attachmentKey: string) => Promise<unknown>;
}

export interface AttachmentResult {
  postId: number;
  attached: AttachmentKind[];
  failures: AttachmentFailure[];
  imageAssetId: string | null;
  videoAttachmentKey: string | null;
}

export function createClientOperationKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

export class SubmissionLock {
  private pending = false;

  tryAcquire(): boolean {
    if (this.pending) return false;
    this.pending = true;
    return true;
  }

  release(): void {
    this.pending = false;
  }
}

export async function attachComposerMedia(
  postId: number,
  draft: AttachmentDraft,
  dependencies: Pick<ComposerDependencies, 'uploadImage' | 'attachImage' | 'attachYouTube'>,
): Promise<AttachmentResult> {
  const attached: AttachmentKind[] = [];
  const failures: AttachmentFailure[] = [];
  let imageAssetId = draft.imageAssetId ?? null;
  let videoAttachmentKey = draft.videoAttachmentKey ?? null;

  if (draft.imageFile || imageAssetId) {
    try {
      if (!imageAssetId) {
        if (!draft.imageFile) throw new Error('The selected image is no longer available.');
        const uploaded = await dependencies.uploadImage(draft.imageFile);
        if (!/^[a-f0-9]{32}$/.test(uploaded?.asset?.id || '')) {
          throw new Error('The server returned an invalid asset response.');
        }
        imageAssetId = uploaded.asset.id;
      }
      await dependencies.attachImage(imageAssetId, postId, draft.imageAltText ?? '');
      attached.push('image');
      imageAssetId = null;
    } catch (error) {
      failures.push({ kind: 'image', error });
    }
  }
  if (draft.youtubeUrl.trim()) {
    try {
      videoAttachmentKey ||= createClientOperationKey();
      await dependencies.attachYouTube(draft.youtubeUrl.trim(), postId, videoAttachmentKey);
      attached.push('video');
      videoAttachmentKey = null;
    } catch (error) {
      failures.push({ kind: 'video', error });
    }
  }
  return { postId, attached, failures, imageAssetId, videoAttachmentKey };
}

export async function submitComposerPost(
  content: string,
  draft: AttachmentDraft,
  submissionKey: string,
  dependencies: ComposerDependencies,
): Promise<AttachmentResult> {
  const created = await dependencies.createPost(content.trim() || '(image)', submissionKey);
  if (!Number.isSafeInteger(created?.post?.id) || created.post.id <= 0) {
    throw new Error('The server returned an invalid post response.');
  }
  return attachComposerMedia(created.post.id, draft, dependencies);
}
