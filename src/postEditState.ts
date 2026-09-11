export interface PostEditState {
  postId: number | null;
  draft: string;
  expectedEditVersion: number;
  saving: boolean;
  error: string;
}

export const EMPTY_POST_EDIT: PostEditState = {
  postId: null,
  draft: '',
  expectedEditVersion: 0,
  saving: false,
  error: '',
};

export function beginPostEdit(post: any): PostEditState {
  return {
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

export function failPostEditSave(state: PostEditState, error: string): PostEditState {
  return { ...state, saving: false, error };
}
