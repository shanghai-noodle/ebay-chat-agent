export interface ItemAspects {
  [key: string]: string[];
}

export interface ListingDraft {
  id: string; // unique draft ID (e.g. uuid or timestamp)
  spaceId: string;
  threadKey: string;
  userEmail?: string;
  
  // Status: DRAFT -> READY_TO_PUBLISH -> PUBLISHED | FAILED
  status: 'DRAFT' | 'READY_TO_PUBLISH' | 'PUBLISHED' | 'FAILED';
  
  // Item details extracted & editable
  title: string;
  descriptionHtml: string;
  condition: 'NEW' | 'LIKE_NEW' | 'USED_EXCELLENT' | 'USED_GOOD' | 'FOR_PARTS_OR_NOT_WORKING';
  conditionDescription?: string;
  aspects: ItemAspects;
  
  // eBay Specifics
  categoryId?: string;
  categoryName?: string;
  price: number;
  currency: string;
  quantity: number;
  shippingCost?: number; // 0 or undefined = Free shipping, > 0 = flat rate shipping fee
  
  // Images
  imageUrls: string[]; // EPS URLs (https://i.ebayimg.com/...)
  
  // Market Intelligence & Competitor Pricing
  marketIntelligence?: MarketIntelligence;

  // Publication results
  sku?: string;
  offerId?: string;
  listingId?: string;
  listingUrl?: string;
  messageName?: string; // Google Chat resource name of the card message (e.g. spaces/.../messages/...)
  
  createdAt: number;
  updatedAt: number;
}

export interface MarketIntelligence {
  activeCompRange?: string; // e.g. "$45.00 - $65.00"
  recentSoldRange?: string; // e.g. "$40.00 - $55.00"
  competitorSummary?: string; // e.g. "Most similar brand new listings range from $48 to $62. Recent sold listings averaged ~$52 with free shipping."
}
