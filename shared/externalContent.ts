export type ExternalSourceKind = 'rss' | 'youtube_channel' | 'youtube_playlist' | string;
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
