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
}
