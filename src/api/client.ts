const BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${url}`, { headers, ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err: any = new Error((body as any).error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = body;
    throw err;
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
  feed: (params?: { mode?: string; limit?: number; offset?: number; level?: string; exposure?: string }) => {
    const qs = new URLSearchParams(params as any).toString();
    return request<{ posts: any[]; worldItems?: any[]; items?: any[]; level?: string }>(`/feed?${qs}`);
  },
  replenishFeed: () =>
    request<{ ok: boolean; sourcesChecked: number; newItems: number; nextAvailableAt?: string }>('/feed/replenish', { method: 'POST' }),

  // Posts
  createPost: (content: string, groupId?: number) =>
    request<{ post: any }>('/posts', { method: 'POST', body: JSON.stringify({ content, groupId }) }),
  getPost: (id: number) => request<{ post: any }>(`/posts/${id}`),
  deletePost: (id: number) => request<{ ok: boolean }>(`/posts/${id}`, { method: 'DELETE' }),

  // Users
  getUser: (username: string) => request<{ user: any }>(`/users/${username}`),
  updateProfile: (data: { displayName?: string; bio?: string; profileVisibility?: string; feedExposure?: string; worldHomeInjection?: string; gameDiscoveryEnabled?: boolean; avatar_url?: string; dmPrivacy?: string }) =>
    request<{ user: any }>('/users/profile', { method: 'PUT', body: JSON.stringify(data) }),
  searchUsers: (q: string) => request<{ users: any[] }>(`/users?q=${encodeURIComponent(q)}`),
  getMyGames: () => request<{ gamePrefs: any[] }>('/users/me/games'),
  getFriends: () => request<{ users: any[] }>('/users/me/friends'),
  getFollowing: () => request<{ users: any[] }>('/users/me/following'),
  getFollowers: () => request<{ users: any[] }>('/users/me/followers'),

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
  getGroups: (q?: string) => request<{ groups: any[] }>(`/groups${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getGroup: (id: number) => request<{ group: any; members: any[]; posts: any[] }>(`/groups/${id}`),
  joinGroup: (id: number) => request<{ ok: boolean }>(`/groups/${id}/join`, { method: 'POST' }),
  leaveGroup: (id: number) => request<{ ok: boolean }>(`/groups/${id}/leave`, { method: 'POST' }),
  removeGroupMember: (groupId: number, userId: number) =>
    request<{ ok: boolean }>(`/groups/${groupId}/members/${userId}`, { method: 'DELETE' }),

  // Notifications
  getNotifications: () => request<{ notifications: any[] }>('/notifications'),
  unreadCount: () => request<{ count: number }>('/notifications/unread-count'),
  readAll: () => request<{ ok: boolean }>('/notifications/read-all', { method: 'POST' }),
  markNotificationRead: (id: number) => request<{ ok: boolean }>(`/notifications/${id}/read`, { method: 'PATCH' }),

  // Direct Messages
  getConversations: () => request<{ conversations: any[] }>('/messages'),
  startConversation: (userId: number) =>
    request<{ conversationId: number }>('/messages', { method: 'POST', body: JSON.stringify({ userId }) }),
  getMessages: (conversationId: number, before?: number) =>
    request<{ messages: any[]; hasMore: boolean; otherUser: any; lastReadMessageId: number | null }>(
      `/messages/${conversationId}${before ? `?before=${before}` : ''}`
    ),
  sendMessage: (conversationId: number, body: string) =>
    request<{ message: any }>(`/messages/${conversationId}`, { method: 'POST', body: JSON.stringify({ body }) }),
  markConversationRead: (conversationId: number) =>
    request<{ ok: boolean }>(`/messages/${conversationId}/read`, { method: 'POST' }),
  deleteMessage: (conversationId: number, messageId: number) =>
    request<{ ok: boolean }>(`/messages/${conversationId}/messages/${messageId}`, { method: 'DELETE' }),
  dmUnreadCount: () => request<{ count: number }>('/messages/unread-count'),

  // Admin
  getUsers: () => request<{ users: any[] }>('/admin/users'),
  banUser: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}/ban`, { method: 'POST' }),
  unbanUser: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}/unban`, { method: 'POST' }),
  deleteUser: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}`, { method: 'DELETE' }),
  getAdminPosts: () => request<{ posts: any[] }>('/admin/posts'),
  hidePost: (id: number) => request<{ ok: boolean }>(`/admin/posts/${id}/hide`, { method: 'POST' }),
  unhidePost: (id: number) => request<{ ok: boolean }>(`/admin/posts/${id}/unhide`, { method: 'POST' }),
  getReports: () => request<{ reports: any[] }>('/admin/reports'),
  reportPost: (postId: number, reason: string, details: string) =>
    request<{ ok: boolean }>('/admin/reports', { method: 'POST', body: JSON.stringify({ postId, reason, details }) }),
  getAuthEvents: (params?: { eventType?: string; success?: string; userId?: number }) => {
    const qs = params ? new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)]))).toString() : '';
    return request<{ events: any[] }>(`/admin/auth-events${qs ? `?${qs}` : ''}`);
  },
  getUserActivity: (id: number) =>
    request<{ user: any; events: any[]; postCount: number; commentCount: number; providers: any[] }>(`/admin/users/${id}/activity`),
  generatePasswordResetToken: (id: number) =>
    request<{ ok: boolean; resetLink: string; expiresAt: string; username: string }>(`/admin/users/${id}/password-reset-token`, { method: 'POST' }),
  getSystemHealth: () => request<any>('/admin/system-health'),
  getAnalyticsSummary: () => request<any>('/admin/analytics/summary'),
  getAnalyticsPeakHours: () => request<any>('/admin/analytics/peak-hours'),
  getAnalyticsFeatureUsage: () => request<any>('/admin/analytics/feature-usage'),
  trackPageView: (route: string, featureArea?: string) =>
    request<{ ok: boolean }>('/usage/event', { method: 'POST', body: JSON.stringify({ eventType: 'page_view', route, featureArea }) }),
  validateResetToken: (token: string) =>
    request<{ ok: boolean; username: string }>(`/auth/reset-password?token=${encodeURIComponent(token)}`),
  submitPasswordReset: (token: string, newPassword: string) =>
    request<{ ok: boolean; message: string }>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),

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
