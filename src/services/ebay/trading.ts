import { ListingDraft } from '../../types/draft';

export interface EbayTradingConfig {
  epsUrl: string; // https://api.sandbox.ebay.com/ws/api.dll or https://api.ebay.com/ws/api.dll
  userToken: string;
  appId?: string;
  devId?: string;
  certId?: string;
  siteId?: string; // 0 for US
}

export class EbayTradingService {
  constructor(private config: EbayTradingConfig) {}

  /**
   * Publishes an item to eBay via the Trading AddItem XML API.
   * Works natively with eBay Auth'n'Auth tokens without requiring business policy IDs.
   */
  async addItem(draft: ListingDraft): Promise<{ listingId: string; listingUrl: string }> {
    return this.executeAddItem(draft, 0);
  }

  private async executeAddItem(
    draft: ListingDraft,
    retryCount = 0
  ): Promise<{ listingId: string; listingUrl: string }> {
    const siteId = this.config.siteId || '0';

    // Ensure standard required aspects for eBay marketplace
    const aspects = { ...(draft.aspects || {}) };
    if (!aspects['Brand'] && !aspects['brand']) {
      aspects['Brand'] = ['Unbranded'];
    }

    // Ensure dimension aspects for furniture/cabinets/wardrobes
    const catNameLower = (draft.categoryName || '').toLowerCase();
    if (
      draft.categoryId === '103430' ||
      draft.categoryId === '261252' ||
      catNameLower.includes('furniture') ||
      catNameLower.includes('wardrobe') ||
      catNameLower.includes('armoire') ||
      catNameLower.includes('cabinet') ||
      catNameLower.includes('dresser') ||
      catNameLower.includes('desk') ||
      catNameLower.includes('table') ||
      catNameLower.includes('shelf') ||
      catNameLower.includes('shelv') ||
      catNameLower.includes('chair') ||
      catNameLower.includes('bed') ||
      catNameLower.includes('stand')
    ) {
      if (!aspects['Item Height']) aspects['Item Height'] = ['72 in'];
      if (!aspects['Item Width']) aspects['Item Width'] = ['48 in'];
      if (!aspects['Item Length'] && !aspects['Item Depth']) aspects['Item Length'] = ['24 in'];
    }

    // Specific aspects that eBay strictly requires to have only a single value
    const singleValuedAspectNames = ['Brand', 'Franchise', 'Type', 'Model', 'Character', 'Department', 'Theme'];
    for (const name of singleValuedAspectNames) {
      if (aspects[name] && Array.isArray(aspects[name]) && aspects[name].length > 1) {
        aspects[name] = [aspects[name][0]];
      }
    }

    // Format item specifics XML
    const aspectsXml = Object.entries(aspects)
      .map(([name, values]) => {
        const valueList = Array.isArray(values) ? values : [values];
        const valElements = valueList.map((v) => `<Value><![CDATA[${v}]]></Value>`).join('');
        return `<NameValueList><Name><![CDATA[${name}]]></Name>${valElements}</NameValueList>`;
      })
      .join('');

    // Format pictures XML
    const picturesXml = (draft.imageUrls || [])
      .map((url) => `<PictureURL>${url}</PictureURL>`)
      .join('');

    // Condition ID mapping:
    // 1000 = Brand New, 1500 = Open Box / Like New, 3000 = Used / Good, 7000 = For Parts
    const conditionId =
      draft.condition === 'NEW'
        ? 1000
        : draft.condition === 'LIKE_NEW'
        ? 1500
        : draft.condition === 'FOR_PARTS_OR_NOT_WORKING'
        ? 7000
        : 3000;

    const isOAuth = this.config.userToken.startsWith('v^1.');
    const requesterCredentialsXml = isOAuth
      ? ''
      : `  <RequesterCredentials>
    <eBayAuthToken>${this.config.userToken}</eBayAuthToken>
  </RequesterCredentials>`;

    const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<AddItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
${requesterCredentialsXml}
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <Title><![CDATA[${draft.title.slice(0, 80)}]]></Title>
    <Description><![CDATA[${draft.descriptionHtml}]]></Description>
    <PrimaryCategory>
      <CategoryID>${draft.categoryId || '15709'}</CategoryID>
    </PrimaryCategory>
    <StartPrice currencyID="${draft.currency || 'USD'}">${draft.price.toFixed(2)}</StartPrice>
    <ConditionID>${conditionId}</ConditionID>
    ${draft.conditionDescription ? `<ConditionDescription><![CDATA[${draft.conditionDescription}]]></ConditionDescription>` : ''}
    <Country>US</Country>
    <Currency>${draft.currency || 'USD'}</Currency>
    <DispatchTimeMax>3</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <PostalCode>94587</PostalCode>
    <Quantity>${draft.quantity || 1}</Quantity>
    ${aspectsXml ? `<ItemSpecifics>${aspectsXml}</ItemSpecifics>` : ''}
    ${picturesXml ? `<PictureDetails>${picturesXml}</PictureDetails>` : ''}
    <ReturnPolicy>
      <ReturnsAcceptedOption>ReturnsNotAccepted</ReturnsAcceptedOption>
    </ReturnPolicy>
    <ShippingDetails>
      <ShippingType>Flat</ShippingType>
      <ShippingServiceOptions>
        <ShippingServicePriority>1</ShippingServicePriority>
        <ShippingService>USPSPriority</ShippingService>
        <ShippingServiceCost currencyID="${draft.currency || 'USD'}">${(!draft.shippingCost || draft.shippingCost <= 0) ? '0.00' : draft.shippingCost.toFixed(2)}</ShippingServiceCost>
        <FreeShipping>${(!draft.shippingCost || draft.shippingCost <= 0) ? 'true' : 'false'}</FreeShipping>
      </ShippingServiceOptions>
    </ShippingDetails>
  </Item>
</AddItemRequest>`;

    const headers: Record<string, string> = {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-CALL-NAME': 'AddItem',
      'X-EBAY-API-SITEID': siteId,
    };
    if (this.config.appId) headers['X-EBAY-API-APP-NAME'] = this.config.appId;
    if (this.config.devId) headers['X-EBAY-API-DEV-NAME'] = this.config.devId;
    if (this.config.certId) headers['X-EBAY-API-CERT-NAME'] = this.config.certId;
    if (isOAuth) {
      headers['X-EBAY-API-IAF-TOKEN'] = this.config.userToken;
    }

    const res = await fetch(this.config.epsUrl, {
      method: 'POST',
      headers,
      body: xmlPayload,
    });

    const responseText = await res.text();

    const ackMatch = responseText.match(/<Ack>([^<]+)<\/Ack>/i);
    const ack = ackMatch ? ackMatch[1] : 'Failure';

    if (ack !== 'Success' && ack !== 'Warning') {
      const errorMatch = responseText.match(/<LongMessage>([^<]+)<\/LongMessage>/i);
      const errMsg = errorMatch ? errorMatch[1] : 'Unknown eBay AddItem error';

      // Check if eBay is complaining about a missing required item specific
      const missingAspectMatch = errMsg.match(/item specific\s+([^.\u00A0]+)[\s\u00A0]+is missing/i);
      if (missingAspectMatch && retryCount < 3) {
        const missingSpecific = missingAspectMatch[1].trim();
        console.warn(`[eBayTrading] Missing required aspect detected: "${missingSpecific}". Auto-remedying and retrying...`);
        let fallbackVal = 'Standard';
        const lower = missingSpecific.toLowerCase();
        if (
          lower.includes('height') ||
          lower.includes('width') ||
          lower.includes('length') ||
          lower.includes('depth') ||
          lower.includes('dimension')
        ) {
          fallbackVal = '24 in';
        } else if (lower.includes('brand')) {
          fallbackVal = 'Unbranded';
        } else if (lower.includes('type')) {
          fallbackVal = 'Standard';
        } else if (lower.includes('material')) {
          fallbackVal = 'Unknown';
        }
        draft.aspects = draft.aspects || {};
        draft.aspects[missingSpecific] = [fallbackVal];
        return this.executeAddItem(draft, retryCount + 1);
      }

      // Check if eBay is complaining about multiple values on a single-valued aspect
      const singleValueMatch = errMsg.match(/([a-zA-Z0-9_\s]+)\s+should contain only one value/i);
      if (singleValueMatch && retryCount < 3) {
        const aspectName = singleValueMatch[1].trim();
        console.warn(`[eBayTrading] Aspect "${aspectName}" has multiple values. Auto-healing to single value and retrying...`);
        if (draft.aspects && draft.aspects[aspectName] && Array.isArray(draft.aspects[aspectName])) {
          draft.aspects[aspectName] = [draft.aspects[aspectName][0]];
        }
        return this.executeAddItem(draft, retryCount + 1);
      }

      throw new Error(`eBay AddItem failed (${ack}): ${errMsg}`);
    }

    const itemMatch = responseText.match(/<ItemID>([^<]+)<\/ItemID>/i);
    if (!itemMatch || !itemMatch[1]) {
      throw new Error('eBay AddItem succeeded, but no ItemID was returned.');
    }

    const listingId = itemMatch[1];
    const isSandbox = this.config.epsUrl.includes('sandbox');
    const listingUrl = isSandbox
      ? `https://www.sandbox.ebay.com/itm/${listingId}`
      : `https://www.ebay.com/itm/${listingId}`;

    return { listingId, listingUrl };
  }

  /**
   * Retrieves all active eBay listings for the seller account,
   * checking the KV catalog snapshot first (<5ms) or querying eBay Trading API directly.
   */
  async getActiveSellerListings(
    forceRefresh = false,
    env?: any
  ): Promise<SellerInventorySummary> {
    // 1. Fast path: Check DRAFTS_KV for the catalog snapshot
    if (!forceRefresh && env?.DRAFTS_KV) {
      try {
        const snap = await env.DRAFTS_KV.get('showcase:hourly_catalog_v4', 'json');
        if (snap && Array.isArray(snap.products) && snap.products.length > 0) {
          const items: ActiveListingItem[] = snap.products
            .map((p: any) => ({
              itemId: String(p.ebay_item_id || '').trim(),
              title: p.title || '',
              price: Number(p.price_cents || 0) / 100,
              quantity: Number(p.ebay_stock_qty || 1),
              listingUrl: p.ebay_listing_url || `https://www.ebay.com/itm/${p.ebay_item_id}`,
              categoryGroup: p.category_group || 'Transformers',
              toyline: p.toyline || '',
              faction: p.faction || '',
              condition: p.condition_grade || 'MISB',
              photosCount: Array.isArray(p.gallery) ? p.gallery.length : (p.image_url ? 1 : 0),
              imageUrl: p.image_url || (Array.isArray(p.gallery) ? p.gallery[0] : ''),
            }))
            .filter((i: ActiveListingItem) => Boolean(i.itemId));

          if (items.length > 0) {
            return this.buildInventorySummary(items, snap.lastSyncedAt || new Date().toISOString());
          }
        }
      } catch (err) {
        console.warn('[eBayTrading] KV snapshot read error:', err);
      }
    }

    // 2. Direct fetch via eBay GetSellerList API
    const items = await this.fetchLiveGetSellerList();
    const summary = this.buildInventorySummary(items, new Date().toISOString());

    // Cache snapshot to KV if available
    if (env?.DRAFTS_KV && items.length > 0) {
      try {
        await env.DRAFTS_KV.put(
          'showcase:hourly_catalog_v4',
          JSON.stringify({
            products: items.map((i) => ({
              id: `prod_ebay_${i.itemId}`,
              ebay_item_id: i.itemId,
              title: i.title,
              category_group: i.categoryGroup,
              faction: i.faction,
              toyline: i.toyline,
              condition_grade: i.condition,
              price_cents: Math.round(i.price * 100),
              ebay_stock_qty: i.quantity,
              ebay_listing_url: i.listingUrl,
              image_url: i.imageUrl,
              gallery: i.imageUrl ? [i.imageUrl] : [],
            })),
            lastSyncedAt: summary.lastSyncedAt,
          })
        );
      } catch {
        // Ignore KV write failure
      }
    }

    return summary;
  }

  private async fetchLiveGetSellerList(): Promise<ActiveListingItem[]> {
    const siteId = this.config.siteId || '0';
    const isOAuth = this.config.userToken.startsWith('v^1.');
    const requesterCredentialsXml = isOAuth
      ? ''
      : `  <RequesterCredentials>
    <eBayAuthToken>${this.config.userToken}</eBayAuthToken>
  </RequesterCredentials>`;

    const now = new Date();
    const endFrom = now.toISOString();
    const endTo = new Date(now.getTime() + 115 * 24 * 60 * 60 * 1000).toISOString();

    const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
${requesterCredentialsXml}
  <EndTimeFrom>${endFrom}</EndTimeFrom>
  <EndTimeTo>${endTo}</EndTimeTo>
  <GranularityLevel>Fine</GranularityLevel>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination>
    <EntriesPerPage>100</EntriesPerPage>
    <PageNumber>1</PageNumber>
  </Pagination>
</GetSellerListRequest>`;

    const headers: Record<string, string> = {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-CALL-NAME': 'GetSellerList',
      'X-EBAY-API-SITEID': siteId,
    };
    if (this.config.appId) headers['X-EBAY-API-APP-NAME'] = this.config.appId;
    if (this.config.devId) headers['X-EBAY-API-DEV-NAME'] = this.config.devId;
    if (this.config.certId) headers['X-EBAY-API-CERT-NAME'] = this.config.certId;
    if (isOAuth) headers['X-EBAY-API-IAF-TOKEN'] = this.config.userToken;

    const res = await fetch(this.config.epsUrl, {
      method: 'POST',
      headers,
      body: xmlPayload,
    });

    const responseText = await res.text();
    const itemBlocks = responseText.split('<Item>').slice(1).map((b) => b.split('</Item>')[0]);
    const items: ActiveListingItem[] = [];
    const seen = new Set<string>();

    for (const block of itemBlocks) {
      const idMatch = block.match(/<ItemID>([^<]+)<\/ItemID>/i);
      const itemId = idMatch ? idMatch[1] : '';
      if (!itemId || seen.has(itemId)) continue;
      seen.add(itemId);

      const titleMatch = block.match(/<Title>([^<]+)<\/Title>/i);
      const rawTitle = titleMatch ? titleMatch[1] : '';
      const title = rawTitle
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();

      const priceMatch = block.match(/<CurrentPrice[^>]*>([^<]+)<\/CurrentPrice>/i);
      const price = priceMatch ? parseFloat(priceMatch[1]) : 0;

      const qtyMatch = block.match(/<Quantity>(\d+)<\/Quantity>/i);
      const soldMatch = block.match(/<QuantitySold>(\d+)<\/QuantitySold>/i);
      const totalQty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
      const soldQty = soldMatch ? parseInt(soldMatch[1], 10) : 0;

      const condMatch = block.match(/<ConditionDisplayName>([^<]+)<\/ConditionDisplayName>/i);
      const condition = condMatch ? condMatch[1].trim() : 'MISB';

      const picMatches = [...block.matchAll(/<PictureURL>([^<]+)<\/PictureURL>/gi)];
      const firstPic = picMatches.length > 0 ? picMatches[0][1].replace('http://', 'https://') : '';

      const viewUrlMatch = block.match(/<ViewItemURL>([^<]+)<\/ViewItemURL>/i);
      const listingUrl = viewUrlMatch ? viewUrlMatch[1] : `https://www.ebay.com/itm/${itemId}`;

      // Categorization
      const tLow = title.toLowerCase();
      let categoryGroup = 'Transformers';
      if (/lego|hogwarts|building set/i.test(tLow)) {
        categoryGroup = 'LEGO & Sets';
      } else if (/disney|pixar|cars\b|lightning mcqueen/i.test(tLow)) {
        categoryGroup = 'Disney & Pop Culture';
      } else if (/diecast|die-cast|camaro|volkswagen|beetle|bus|greenlight|jada|matchbox|spacex/i.test(tLow)) {
        categoryGroup = 'Die-Cast & Vehicles';
      }

      items.push({
        itemId,
        title,
        price,
        quantity: Math.max(1, totalQty - soldQty),
        listingUrl,
        categoryGroup,
        condition,
        photosCount: picMatches.length,
        imageUrl: firstPic,
      });
    }

    return items;
  }

  private buildInventorySummary(
    items: ActiveListingItem[],
    lastSyncedAt: string
  ): SellerInventorySummary {
    const totalCount = items.length;
    const totalValue = items.reduce((sum, item) => sum + item.price, 0);
    const averagePrice = totalCount > 0 ? totalValue / totalCount : 0;

    const categoryCounts: Record<string, number> = {};
    for (const item of items) {
      const cat = item.categoryGroup || 'General';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    const topValuable = items
      .slice()
      .sort((a, b) => b.price - a.price)
      .slice(0, 5);

    return {
      totalCount,
      totalValue,
      averagePrice,
      categoryCounts,
      topValuable,
      items,
      lastSyncedAt,
    };
  }
}

export interface ActiveListingItem {
  itemId: string;
  title: string;
  price: number;
  quantity: number;
  listingUrl: string;
  categoryGroup: string;
  toyline?: string;
  faction?: string;
  condition?: string;
  photosCount: number;
  imageUrl?: string;
}

export interface SellerInventorySummary {
  totalCount: number;
  totalValue: number;
  averagePrice: number;
  categoryCounts: Record<string, number>;
  topValuable: ActiveListingItem[];
  items: ActiveListingItem[];
  lastSyncedAt: string;
}
