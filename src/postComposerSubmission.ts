export type AttachmentKind = 'image' | 'video';

export interface AttachmentFailure {
  kind: AttachmentKind;
  error: unknown;
}

export interface AttachmentDraft {
  imageFile: File | null;
  youtubeUrl: string;
}

export interface ComposerDependencies {
  createPost: (content: string) => Promise<{ post: { id: number } }>;
  uploadImage: (file: File, postId: number) => Promise<unknown>;
  attachYouTube: (url: string, postId: number) => Promise<unknown>;
}

export interface AttachmentResult {
  postId: number;
  attached: AttachmentKind[];
  failures: AttachmentFailure[];
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
  dependencies: Pick<ComposerDependencies, 'uploadImage' | 'attachYouTube'>,
): Promise<AttachmentResult> {
  const attached: AttachmentKind[] = [];
  const failures: AttachmentFailure[] = [];

  if (draft.imageFile) {
    try {
      await dependencies.uploadImage(draft.imageFile, postId);
      attached.push('image');
    } catch (error) {
      failures.push({ kind: 'image', error });
    }
  }
  if (draft.youtubeUrl.trim()) {
    try {
      await dependencies.attachYouTube(draft.youtubeUrl.trim(), postId);
      attached.push('video');
    } catch (error) {
      failures.push({ kind: 'video', error });
    }
  }
  return { postId, attached, failures };
}

export async function submitComposerPost(
  content: string,
  draft: AttachmentDraft,
  dependencies: ComposerDependencies,
): Promise<AttachmentResult> {
  const created = await dependencies.createPost(content.trim() || '(image)');
  if (!Number.isSafeInteger(created?.post?.id) || created.post.id <= 0) {
    throw new Error('The server returned an invalid post response.');
  }
  return attachComposerMedia(created.post.id, draft, dependencies);
}
