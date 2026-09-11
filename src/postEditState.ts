export interface PostEditState {
  postId: number | null;
  draft: string;
  expectedEditVersion: number;
  saving: boolean;
  error: string;
  conflict: boolean;
  latestContent: string | null;
}

export const EMPTY_POST_EDIT: PostEditState = {
  postId: null,
  draft: '',
  expectedEditVersion: 0,
  saving: false,
  error: '',
  conflict: false,
  latestContent: null,
};

export function beginPostEdit(post: any): PostEditState {
  return {
    ...EMPTY_POST_EDIT,
    postId: post.id,
    draft: post.content || '',
    expectedEditVersion: Number(post.editVersion || 0),
    saving: false,
    error: '',
  };
}

export function updatePostEditDraft(state: PostEditState, draft: string): PostEditState {
  return { ...state, draft, error: '' };
}

export function startPostEditSave(state: PostEditState): PostEditState {
  return { ...state, saving: true, error: '' };
}

export function failPostEditSave(state: PostEditState, error: string, conflict = state.conflict): PostEditState {
  return { ...state, saving: false, error, conflict };
}

export function reviewLatestPost(state: PostEditState, post: any): PostEditState {
  return { ...state, expectedEditVersion: post.editVersion, latestContent: post.content, conflict: false, saving: false, error: '' };
}
