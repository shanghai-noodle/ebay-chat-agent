import { EbayCategorySuggestion, EbayTaxonomySuggestionsResponse } from '../../types/ebay';

export interface EbayTaxonomyConfig {
  apiBase: string; // e.g. https://api.sandbox.ebay.com
  appId?: string;
  certId?: string;
  token?: string;
  categoryTreeId?: string; // default 0 for EBAY_US
}

export class EbayTaxonomyService {
  private appToken: string | null = null;

  constructor(private config: EbayTaxonomyConfig) {
    if (config.token) {
      this.appToken = config.token;
    }
  }

  private async getAppToken(): Promise<string> {
    if (this.appToken) return this.appToken;
    if (!this.config.appId || !this.config.certId) {
      throw new Error('TaxonomyService requires appId and certId to obtain an application token.');
    }

    const basicAuth = btoa(`${this.config.appId}:${this.config.certId}`);
    const res = await fetch(`${this.config.apiBase}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to obtain eBay application token for taxonomy: ${err}`);
    }

    const data = (await res.json()) as { access_token: string };
    this.appToken = data.access_token;
    return this.appToken;
  }

  /**
   * Suggests the best leaf category for a given query or title.
   */
  async getCategorySuggestion(query: string): Promise<EbayCategorySuggestion | null> {
    const categoryTreeId = this.config.categoryTreeId || '0'; // 0 = EBAY_US
    const encodedQuery = encodeURIComponent(query.slice(0, 100));
    const token = await this.getAppToken();
    const url = `${this.config.apiBase}/commerce/taxonomy/v1/category_tree/${categoryTreeId}/get_category_suggestions?q=${encodedQuery}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`Taxonomy API returned ${res.status}: ${errText}`);
      return null;
    }

    const data = (await res.json()) as EbayTaxonomySuggestionsResponse;
    if (!data.categorySuggestions || data.categorySuggestions.length === 0) {
      return null;
    }

    const topSuggestion = data.categorySuggestions[0];
    return {
      categoryId: topSuggestion.category.categoryId,
      categoryName: topSuggestion.category.categoryName,
      categoryTreeNodeLevel: topSuggestion.categoryTreeNodeLevel,
    };
  }
}
