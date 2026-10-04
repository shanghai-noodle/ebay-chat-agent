import { ListingDraft } from '../../types/draft';
import { EbayInventoryItemPayload, EbayOfferPayload, EbayPublishOfferResponse } from '../../types/ebay';

export interface EbayInventoryConfig {
  apiBase: string; // https://api.sandbox.ebay.com
  marketplaceId: string; // EBAY_US
  userToken: string;
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
}

export class EbayInventoryService {
  constructor(private config: EbayInventoryConfig) {}

  private getHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.userToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Language': 'en-US',
    };
  }

  /**
   * Fetch default seller business policies (fulfillment, payment, return) if not provided.
   */
  async resolvePolicies(): Promise<{ fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string }> {
    let { fulfillmentPolicyId, paymentPolicyId, returnPolicyId } = this.config;

    if (!fulfillmentPolicyId) {
      const res = await fetch(`${this.config.apiBase}/sell/account/v1/fulfillment_policy?marketplace_id=${this.config.marketplaceId}`, {
        headers: this.getHeaders(),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        fulfillmentPolicyId = data.fulfillmentPolicies?.[0]?.fulfillmentPolicyId;
      }
    }

    if (!paymentPolicyId) {
      const res = await fetch(`${this.config.apiBase}/sell/account/v1/payment_policy?marketplace_id=${this.config.marketplaceId}`, {
        headers: this.getHeaders(),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        paymentPolicyId = data.paymentPolicies?.[0]?.paymentPolicyId;
      }
    }

    if (!returnPolicyId) {
      const res = await fetch(`${this.config.apiBase}/sell/account/v1/return_policy?marketplace_id=${this.config.marketplaceId}`, {
        headers: this.getHeaders(),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        returnPolicyId = data.returnPolicies?.[0]?.returnPolicyId;
      }
    }

    if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId) {
      throw new Error(
        `Missing eBay seller business policies. Found: fulfillment=${fulfillmentPolicyId}, payment=${paymentPolicyId}, return=${returnPolicyId}. Please set up Business Policies in your eBay account or provide them in configuration.`
      );
    }

    return { fulfillmentPolicyId, paymentPolicyId, returnPolicyId };
  }

  /**
   * 1. Create or replace the inventory item
   */
  async createOrReplaceInventoryItem(sku: string, draft: ListingDraft): Promise<void> {
    const payload: EbayInventoryItemPayload = {
      availability: {
        shipToLocationAvailability: {
          quantity: draft.quantity || 1,
        },
      },
      condition: draft.condition,
      conditionDescription: draft.conditionDescription,
      product: {
        title: draft.title.slice(0, 80),
        description: draft.descriptionHtml,
        aspects: draft.aspects,
        imageUrls: draft.imageUrls,
      },
    };

    const res = await fetch(`${this.config.apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    if (!res.ok && res.status !== 204 && res.status !== 200 && res.status !== 201) {
      const err = await res.text();
      throw new Error(`Failed to create inventory item (${res.status}): ${err}`);
    }
  }

  /**
   * 2. Create the listing offer
   */
  async createOffer(sku: string, draft: ListingDraft, policies: { fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string }): Promise<string> {
    if (!draft.categoryId) {
      throw new Error('Listing draft is missing a categoryId.');
    }

    const payload: EbayOfferPayload = {
      sku,
      marketplaceId: this.config.marketplaceId,
      format: 'FIXED_PRICE',
      availableQuantity: draft.quantity || 1,
      categoryId: draft.categoryId,
      listingDescription: draft.descriptionHtml,
      pricingSummary: {
        price: {
          value: draft.price.toFixed(2),
          currency: draft.currency || 'USD',
        },
      },
      listingPolicies: {
        fulfillmentPolicyId: policies.fulfillmentPolicyId,
        paymentPolicyId: policies.paymentPolicyId,
        returnPolicyId: policies.returnPolicyId,
      },
    };

    const res = await fetch(`${this.config.apiBase}/sell/inventory/v1/offer`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    if (!res.ok && res.status !== 201) {
      const err = await res.text();
      throw new Error(`Failed to create eBay offer (${res.status}): ${err}`);
    }

    const data = (await res.json()) as { offerId: string };
    return data.offerId;
  }

  /**
   * 3. Publish the offer live
   */
  async publishOffer(offerId: string): Promise<string> {
    const res = await fetch(`${this.config.apiBase}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, {
      method: 'POST',
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to publish eBay offer (${res.status}): ${err}`);
    }

    const data = (await res.json()) as EbayPublishOfferResponse;
    return data.listingId;
  }

  /**
   * Complete publishing pipeline: create item -> create offer -> publish
   */
  async publishDraft(draft: ListingDraft): Promise<{ sku: string; offerId: string; listingId: string; listingUrl: string }> {
    const sku = draft.sku || `ITEM-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const policies = await this.resolvePolicies();

    // 1. Put inventory item
    await this.createOrReplaceInventoryItem(sku, draft);

    // 2. Create offer
    const offerId = await this.createOffer(sku, draft, policies);

    // 3. Publish offer
    const listingId = await this.publishOffer(offerId);

    const isSandbox = this.config.apiBase.includes('sandbox');
    const listingUrl = isSandbox
      ? `https://www.sandbox.ebay.com/itm/${listingId}`
      : `https://www.ebay.com/itm/${listingId}`;

    return { sku, offerId, listingId, listingUrl };
  }
}
