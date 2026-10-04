// eBay Sell API & EPS Types

export interface EbayEPSUploadResponse {
  ack: 'Success' | 'Failure' | 'Warning' | 'PartialFailure';
  fullUrl?: string;
  errorMessage?: string;
}

export interface EbayCategorySuggestion {
  categoryId: string;
  categoryName: string;
  categorySubtreeNodeHref?: string;
  categoryTreeNodeLevel?: number;
}

export interface EbayTaxonomySuggestionsResponse {
  categorySuggestions?: Array<{
    category: {
      categoryId: string;
      categoryName: string;
    };
    categoryTreeNodeAncestors?: Array<{
      categoryId: string;
      categoryName: string;
      categoryTreeNodeLevel: number;
    }>;
    categoryTreeNodeLevel: number;
    relevancy: string;
  }>;
}

export interface EbayInventoryItemPayload {
  availability: {
    shipToLocationAvailability: {
      quantity: number;
    };
  };
  condition: string;
  conditionDescription?: string;
  product: {
    title: string;
    description: string;
    aspects: Record<string, string[]>;
    imageUrls: string[];
  };
}

export interface EbayOfferPayload {
  sku: string;
  marketplaceId: string;
  format: 'FIXED_PRICE';
  availableQuantity: number;
  categoryId: string;
  listingDescription: string;
  pricingSummary: {
    price: {
      value: string;
      currency: string;
    };
  };
  listingPolicies: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  };
}

export interface EbayPublishOfferResponse {
  listingId: string;
}
