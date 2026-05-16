const BASE = '/api';

/**
 * Core fetch wrapper. Auth is handled via HttpOnly cookie automatically sent
 * by the browser with credentials:'include'. No Authorization header or
 * localStorage token involved.
 */
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  // Don't set Content-Type for FormData — browser sets the correct multipart boundary.
  const isFormData = options?.body instanceof FormData;
  const headers: Record<string, string> = isFormData ? {} : { 'Content-Type': 'application/json' };

  const res = await fetch(`${BASE}${url}`, {
    ...options,
    credentials: 'include',  // Always send the HttpOnly auth cookie
    headers: { ...headers, ...(options?.headers as Record<string, string> ?? {}) },
  });

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
    request<{ user: any; needsEmailVerification?: boolean }>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  login: (data: { username: string; password: string }) =>
    request<{ user: any }>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  me: () => request<{ user: any }>('/auth/me'),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  verifyEmail: (token: string) =>
    request<{ ok: boolean; user?: any }>(`/auth/verify-email?token=${encodeURIComponent(token)}`),
  resendVerification: () =>
    request<{ ok: boolean; message: string }>('/auth/resend-verification', { method: 'POST' }),
  forgotPassword: (emailOrUsername: string) =>
    request<{ ok: boolean; message: string }>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ emailOrUsername }) }),

  // Feed
  feed: (params?: { mode?: string; limit?: number; offset?: number; level?: string; exposure?: string }) => {
    const qs = new URLSearchParams(params as any).toString();
    return request<{ posts: any[]; worldItems?: any[]; items?: any[]; level?: string }>(`/feed?${qs}`);
  },
  replenishFeed: () =>
    request<{ ok: boolean; started?: boolean; sourcesChecked: number; newItems?: number; nextAvailableAt?: string }>('/feed/replenish', { method: 'POST' }),

  // Posts
  createPost: (content: string, groupId?: number) =>
    request<{ post: any }>('/posts', { method: 'POST', body: JSON.stringify({ content, groupId }) }),
  getPost: (id: number) => request<{ post: any }>(`/posts/${id}`),
  deletePost: (id: number) => request<{ ok: boolean }>(`/posts/${id}`, { method: 'DELETE' }),

  // Users
  getUser: (username: string) => request<{ user: any }>(`/users/${username}`),
  updateProfile: (data: {
    displayName?: string; bio?: string; profileVisibility?: string;
    feedExposure?: string; worldHomeInjection?: string; gameDiscoveryEnabled?: boolean;
    avatar_url?: string; dmPrivacy?: string;
    profileData?: {
      techInterests?: string; platforms?: string; lookingFor?: string;
      currentProjects?: string; favoriteGenres?: string; websiteUrl?: string;
    };
  }) => request<{ user: any }>('/users/profile', { method: 'PUT', body: JSON.stringify(data) }),
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
  getUsers: (params?: { q?: string; role?: string; page?: number; limit?: number }) => {
    const qs = params ? new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)]))).toString() : '';
    return request<{ users: any[]; page: number; limit: number; total: number; totalPages: number; activeAdminCount?: number }>(`/admin/users${qs ? `?${qs}` : ''}`);
  },
  banUser: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}/ban`, { method: 'POST' }),
  unbanUser: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}/unban`, { method: 'POST' }),
  deleteUser: (id: number) => request<{ ok: boolean }>(`/admin/users/${id}`, { method: 'DELETE' }),
  getAdminPosts: () => request<{ posts: any[] }>('/admin/posts'),
  hidePost: (id: number) => request<{ ok: boolean }>(`/admin/posts/${id}/hide`, { method: 'POST' }),
  unhidePost: (id: number) => request<{ ok: boolean }>(`/admin/posts/${id}/unhide`, { method: 'POST' }),
  getReports: () => request<{ reports: any[] }>('/admin/reports'),
  reportPost: (postId: number, reason: string, details: string) =>
    request<{ ok: boolean }>('/admin/reports', { method: 'POST', body: JSON.stringify({ postId, reason, details }) }),
  getAuthEvents: (params?: { eventType?: string; success?: string; userId?: number; page?: number; limit?: number }) => {
    const qs = params ? new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v]) => v !== undefined && v !== '').map(([k,v]) => [k, String(v)]))).toString() : '';
    return request<{ events: any[]; page: number; limit: number; total: number; totalPages: number }>(`/admin/auth-events${qs ? `?${qs}` : ''}`);
  },
  getUserActivity: (id: number) =>
    request<{ user: any; events: any[]; postCount: number; commentCount: number; providers: any[] }>(`/admin/users/${id}/activity`),
  generatePasswordResetToken: (id: number) =>
    request<{ ok: boolean; resetLink: string; expiresAt: string; username: string }>(`/admin/users/${id}/password-reset-token`, { method: 'POST' }),
  getSystemHealth: () => request<any>('/admin/system-health'),
  getBackupStatus: () => request<any>('/admin/backups/status'),
  runBackup: () => request<any>('/admin/backups/run', { method: 'POST' }),
  runUploadBackup: () => request<any>('/admin/backups/run-uploads', { method: 'POST' }),
  getAnalyticsSummary: () => request<any>('/admin/analytics/summary'),
  getAnalyticsPeakHours: () => request<any>('/admin/analytics/peak-hours'),
  getAnalyticsFeatureUsage: () => request<any>('/admin/analytics/feature-usage'),
  trackPageView: (route: string, featureArea?: string) =>
    request<{ ok: boolean }>('/usage/event', { method: 'POST', body: JSON.stringify({ eventType: 'page_view', route, featureArea }) }),
  validateResetToken: (token: string) =>
    request<{ ok: boolean; username: string }>(`/auth/reset-password?token=${encodeURIComponent(token)}`),
  submitPasswordReset: (token: string, newPassword: string) =>
    request<{ ok: boolean; message: string }>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),

  // Media — uses credentials:'include' via request() for cookie auth
  uploadImage: async (file: File): Promise<{ media: any }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/uploads/image', {
      method: 'POST',
      credentials: 'include',
      body: form,
      // No Content-Type — browser sets multipart/form-data with boundary automatically
    });
    if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error((body as any).error || 'Upload failed'); }
    return res.json();
  },
  uploadAvatar: async (file: File): Promise<{ media: any }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/uploads/image', {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error((body as any).error || 'Upload failed'); }
    return res.json();
  },
  attachYouTube: (url: string, postId?: number) =>
    request<{ media: any }>('/uploads/external-video', { method: 'POST', body: JSON.stringify({ url, postId }) }),
  getPostMedia: (postId: number) =>
    request<{ media: any[] }>(`/uploads/post/${postId}`),
};
