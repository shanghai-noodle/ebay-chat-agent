import { ListingDraft } from '../../types/draft';
import { SellerInventorySummary } from '../ebay/trading';

export interface ExtractedItemAnalysis {
  title: string;
  categoryKeywords: string;
  condition: 'NEW' | 'LIKE_NEW' | 'USED_EXCELLENT' | 'USED_GOOD' | 'FOR_PARTS_OR_NOT_WORKING';
  conditionDescription: string;
  aspects: Record<string, string[]>;
  descriptionHtml: string;
  suggestedPrice: {
    low: number;
    recommended: number;
    high: number;
  };
  marketIntelligence?: {
    activeCompRange?: string;
    recentSoldRange?: string;
    competitorSummary?: string;
  };
  shippingCost?: number;
}

export interface SheetCustomizationIntent {
  moveColumns?: Array<{ column: string; toPosition: string | number }>;
  columnsToAdd?: Array<{ column?: string; id?: string; title?: string; position?: string | number }>;
  columnsToRemove?: string[];
  colorCodeColumns?: string[];
  rowHeight?: number;
}

export interface SellerChatResponse {
  replyText: string;
  hasDraftUpdates: boolean;
  draftUpdates?: {
    title?: string;
    price?: number;
    shippingCost?: number;
    condition?: 'NEW' | 'LIKE_NEW' | 'USED_EXCELLENT' | 'USED_GOOD' | 'FOR_PARTS_OR_NOT_WORKING';
    conditionDescription?: string;
    descriptionHtml?: string;
    aspects?: Record<string, string[]>;
  };
  isInventoryInquiry?: boolean;
  isSheetExportRequested?: boolean;
  sheetCustomization?: SheetCustomizationIntent;
}

export interface AIService {
  readonly providerName: string;

  /**
   * Analyze one or more product images to extract listing details.
   */
  analyzeItemImages(
    images: Array<{ base64: string; mimeType?: string }>,
    userHint?: string
  ): Promise<ExtractedItemAnalysis>;

  /**
   * Analyze a single product image (convenience helper).
   */
  analyzeItemImage(
    imageBase64: string,
    mimeType?: string
  ): Promise<ExtractedItemAnalysis>;

  /**
   * Refine a listing draft based on user commands.
   */
  refineListing(
    currentDraft: ListingDraft,
    userFeedback: string
  ): Promise<Partial<ListingDraft>>;

  /**
   * Conversational interaction with the seller (Q&A, draft adjustments, inventory insights, sheet requests).
   */
  chatWithSeller(
    userMessage: string,
    currentDraft?: ListingDraft | null,
    inventorySummary?: SellerInventorySummary | null
  ): Promise<SellerChatResponse>;
}
