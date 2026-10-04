export interface EbayEPSConfig {
  epsUrl: string;
  appId?: string;
  devId?: string;
  certId?: string;
  userToken: string;
  siteId?: string; // 0 = US
}

export class EbayEPSService {
  constructor(private config: EbayEPSConfig) {}

  /**
   * Upload an image directly to eBay Picture Services (EPS) using multipart MIME.
   * Returns the permanent eBay image URL (e.g., https://i.sandbox.ebayimg.com/...)
   */
  async uploadPicture(imageBase64: string, pictureName: string = 'ItemPhoto'): Promise<string> {
    const xmlPayload = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${this.config.userToken}</eBayAuthToken>
  </RequesterCredentials>
  <PictureName>${pictureName}</PictureName>
  <PictureSet>Supersize</PictureSet>
</UploadSiteHostedPicturesRequest>`;

    // Convert base64 to binary Blob
    const binary = atob(imageBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'image/jpeg' });

    const formData = new FormData();
    formData.append('XML Payload', xmlPayload);
    formData.append('image', blob, `${pictureName}.jpg`);

    const headers: Record<string, string> = {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
      'X-EBAY-API-CALL-NAME': 'UploadSiteHostedPictures',
      'X-EBAY-API-SITEID': this.config.siteId || '0',
      'X-EBAY-API-DETAIL-LEVEL': '0',
    };

    if (this.config.appId) headers['X-EBAY-API-APP-NAME'] = this.config.appId;
    if (this.config.devId) headers['X-EBAY-API-DEV-NAME'] = this.config.devId;
    if (this.config.certId) headers['X-EBAY-API-CERT-NAME'] = this.config.certId;
    if (this.config.userToken.startsWith('v^1.')) {
      headers['X-EBAY-API-IAF-TOKEN'] = this.config.userToken;
    }

    const response = await fetch(this.config.epsUrl, {
      method: 'POST',
      headers,
      body: formData,
    });

    const responseText = await response.text();

    // Parse Ack and FullURL from XML response
    const ackMatch = responseText.match(/<Ack>([^<]+)<\/Ack>/i);
    const ack = ackMatch ? ackMatch[1] : 'Failure';

    if (ack !== 'Success' && ack !== 'Warning') {
      const errorMatch = responseText.match(/<LongMessage>([^<]+)<\/LongMessage>/i);
      const errorMsg = errorMatch ? errorMatch[1] : 'Unknown EPS upload error';
      throw new Error(`eBay EPS upload failed (${ack}): ${errorMsg}`);
    }

    const urlMatch = responseText.match(/<FullURL>([^<]+)<\/FullURL>/i);
    if (!urlMatch || !urlMatch[1]) {
      throw new Error('eBay EPS returned Success/Warning but no FullURL was found in response.');
    }

    return urlMatch[1];
  }
}
