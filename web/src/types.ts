import type {
  CatalogAddOn,
  CatalogProduct,
  MerchantPublicProfile,
  PublicQuoteDocument,
  QuoteCalculation,
  QuoteDraftData,
  QuoteState,
  RoundingMode,
} from '../../shared/contracts.ts';

export interface Merchant extends MerchantPublicProfile {
  id: string;
  defaultValidDays: number;
  defaultDeliveryPeriod: string;
  defaultTerms: string;
  roundingMode: RoundingMode;
  timezone: string;
  onboardingCompleted: boolean;
}

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
}

export interface CatalogProductView extends CatalogProduct {
  isDemo: boolean;
  lastUsedAt: string | null;
}

export interface CatalogResponse {
  categories: Category[];
  products: CatalogProductView[];
  addOns: CatalogAddOn[];
}

export interface QuoteListItem {
  id: string;
  quoteNumber: string;
  customerName: string;
  projectName: string;
  currentVersion: number;
  draftVersion: number | null;
  hasDraft: boolean;
  state: QuoteState | 'DRAFT';
  total: string | null;
  validUntil: string | null;
  viewed: boolean;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteVersionView {
  id: string;
  version: number;
  state: QuoteState;
  calculation: QuoteCalculation;
  publishedAt: string;
  validUntil: string;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  acceptedAt: string | null;
  supersededByVersion: number | null;
  shareToken: string | null;
  shareUrl: string | null;
  actions: Array<{
    id: string;
    type: string;
    message: string;
    createdAt: string;
  }>;
}

export interface QuoteDetail {
  id: string;
  quoteNumber: string;
  customerName: string;
  projectName: string;
  merchantName: string;
  sharingAvailable: boolean;
  currentVersion: number;
  draftVersion: number | null;
  draftRevision: number;
  draft: QuoteDraftData | null;
  versions: QuoteVersionView[];
}

export interface PublicQuoteResponse {
  available: boolean;
  quote?: PublicQuoteDocument;
  state?: QuoteState;
  quoteNumber?: string;
  version?: number;
  merchant?: MerchantPublicProfile;
  message?: string;
}

export interface NotificationItem {
  id: string;
  quoteId: string;
  versionId: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}
