export interface CanonicalProfileDto {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  isPrivate: boolean;
  isFollowing: boolean;
  followStatus?: 'pending';
  limited?: true;
  bio?: string;
  role?: string;
  isVerified?: boolean;
  profileVisibility?: 'public' | 'private';
  followerCount?: number;
  followingCount?: number;
  postCount?: number;
  gamePrefs?: any[];
  profileData?: Record<string, string> | null;
}
