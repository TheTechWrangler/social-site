const BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${url}`, { headers, ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Auth
export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: any) => request<T>(url, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  register: (data: { username: string; displayName: string; email: string; password: string }) =>
    request<{ user: any; token: string }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  login: (data: { username: string; password: string }) =>
    request<{ user: any; token: string }>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  me: () => request<{ user: any }>('/auth/me'),

  // Feed
  feed: (params?: { mode?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams(params as any).toString();
    return request<{ posts: any[] }>(`/feed?${qs}`);
  },

  // Posts
  createPost: (content: string, groupId?: number) =>
    request<{ post: any }>('/posts', { method: 'POST', body: JSON.stringify({ content, groupId }) }),
  getPost: (id: number) => request<{ post: any }>(`/posts/${id}`),
  deletePost: (id: number) => request<{ ok: boolean }>(`/posts/${id}`, { method: 'DELETE' }),

  // Users
  getUser: (username: string) => request<{ user: any }>(`/users/${username}`),
  updateProfile: (data: { displayName?: string; bio?: string }) =>
    request<{ user: any }>('/users/profile', { method: 'PUT', body: JSON.stringify(data) }),
  searchUsers: (q: string) => request<{ users: any[] }>(`/users?q=${encodeURIComponent(q)}`),

  // Follows
  follow: (userId: number) => request<{ ok: boolean }>(`/follows/${userId}`, { method: 'POST' }),
  unfollow: (userId: number) => request<{ ok: boolean }>(`/follows/${userId}`, { method: 'DELETE' }),

  // Likes
  like: (postId: number) => request<{ liked: boolean; likeCount: number }>(`/likes/${postId}`, { method: 'POST' }),
  unlike: (postId: number) => request<{ liked: boolean; likeCount: number; counts?: any }>(`/likes/${postId}`, { method: 'DELETE' }),

  // Comments
  addComment: (postId: number, content: string) =>
    request<{ comment: any }>(`/comments/${postId}`, { method: 'POST', body: JSON.stringify({ content }) }),
  getComments: (postId: number) => request<{ comments: any[] }>(`/comments/${postId}`),

  // Reposts
  repost: (postId: number) => request<{ post: any }>(`/reposts/${postId}`, { method: 'POST' }),

  // Groups
  createGroup: (name: string, description: string) =>
    request<{ group: any }>('/groups', { method: 'POST', body: JSON.stringify({ name, description }) }),
  getGroups: () => request<{ groups: any[] }>('/groups'),
  getGroup: (id: number) => request<{ group: any; members: any[]; posts: any[] }>(`/groups/${id}`),
  joinGroup: (id: number) => request<{ ok: boolean }>(`/groups/${id}/join`, { method: 'POST' }),
  leaveGroup: (id: number) => request<{ ok: boolean }>(`/groups/${id}/leave`, { method: 'POST' }),

  // Notifications
  getNotifications: () => request<{ notifications: any[] }>('/notifications'),
  unreadCount: () => request<{ count: number }>('/notifications/unread-count'),
  readAll: () => request<{ ok: boolean }>('/notifications/read-all', { method: 'POST' }),

  // Admin
  getUsers: () => request<{ users: any[] }>('/admin/users'),
  banUser: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}/ban`, { method: 'POST' }),
  unbanUser: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}/unban`, { method: 'POST' }),
  getAdminPosts: () => request<{ posts: any[] }>('/admin/posts'),
  hidePost: (id: number) => request<{ ok: boolean }>(`/admin/posts/${id}/hide`, { method: 'POST' }),
  unhidePost: (id: number) => request<{ ok: boolean }>(`/admin/posts/${id}/unhide`, { method: 'POST' }),
  getReports: () => request<{ reports: any[] }>('/admin/reports'),
  reportPost: (postId: number, reason: string) =>
    request<{ ok: boolean }>('/admin/reports', { method: 'POST', body: JSON.stringify({ postId, reason }) }),

  // Media
  uploadImage: async (file: File): Promise<{ media: any }> => {
    const form = new FormData();
    form.append('file', file);
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch('/api/uploads/image', { method: 'POST', headers, body: form });
    if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error((body as any).error || 'Upload failed'); }
    return res.json();
  },
  uploadAvatar: async (file: File): Promise<{ media: any }> => {
    const form = new FormData();
    form.append('file', file);
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch('/api/uploads/image', { method: 'POST', headers, body: form });
    if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error((body as any).error || 'Upload failed'); }
    return res.json();
  },
  attachYouTube: (url: string, postId?: number) =>
    request<{ media: any }>('/uploads/external-video', { method: 'POST', body: JSON.stringify({ url, postId }) }),
  getPostMedia: (postId: number) =>
    request<{ media: any[] }>(`/uploads/post/${postId}`),
};

export function useAuth() {
  const token = localStorage.getItem('token');
  const user = localStorage.getItem('user');
  return {
    isLoggedIn: !!token,
    user: user ? JSON.parse(user) : null,
    token,
    login: (u: any, t: string) => { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify(u)); },
    logout: () => { localStorage.removeItem('token'); localStorage.removeItem('user'); },
  };
}
