export type ExternalSourceKind = 'rss' | 'youtube_channel';
export type ExternalItemKind = 'article' | 'podcast' | 'video';
export type ExternalSourceAvailability = 'active' | 'disabled' | 'removed';
export type PersonalExternalFeedStatus = 'ready' | 'no_subscriptions' | 'no_active_subscriptions' | 'authentication_required';

export interface PublicExternalSourceDto {
  id: number;
  name: string;
  category: string;
  homepageUrl: string;
  sourceKind: ExternalSourceKind;
  availability: ExternalSourceAvailability;
  viewer: { subscribed: boolean; blocked: boolean } | null;
}

export interface ExternalSourceCatalogDto {
  sources: PublicExternalSourceDto[];
  categories: string[];
}

export interface ExternalSubscriptionResult {
  sourceId: number;
  subscribed: boolean;
  blocked: boolean;
}

export type ExternalSourceSubmissionStatus = 'pending' | 'approved' | 'rejected';

export interface ExternalSourceSubmissionDto {
  id: number;
  sourceKind: ExternalSourceKind;
  locator: string;
  name: string;
  category: string;
  note: string;
  status: ExternalSourceSubmissionStatus;
  resultingSourceId: number | null;
  createdAt: string;
  updatedAt: string;
}
