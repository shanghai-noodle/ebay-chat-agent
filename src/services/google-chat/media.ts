export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface ChatAttachment {
  name?: string;
  contentName?: string;
  contentType?: string;
  downloadUri?: string;
  thumbnailUri?: string;
  attachmentDataRef?: {
    resourceName?: string;
  };
  driveDataRef?: {
    driveFileId?: string;
  };
  source?: string;
}

export class GoogleChatMediaService {
  private static cachedToken: { email: string; token: string; expiresAt: number } | null = null;

  /**
   * Generates a Google OAuth2 access token from a service account private key using Web Crypto.
   */
  static async getServiceAccountAccessToken(serviceAccount: ServiceAccountCredentials): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (
      this.cachedToken &&
      this.cachedToken.email === serviceAccount.client_email &&
      this.cachedToken.expiresAt > now + 60
    ) {
      return this.cachedToken.token;
    }

    const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const payload = {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/chat.bot',
      aud: tokenUri,
      exp: now + 3600,
      iat: now,
    };

    const base64UrlEncode = (str: string) => {
      const bytes = new TextEncoder().encode(str);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    // Clean PEM private key
    const pemContents = serviceAccount.private_key
      .replace(/\\n/g, '')
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\s+/g, '');

    const binaryKey = atob(pemContents);
    const keyBytes = new Uint8Array(binaryKey.length);
    for (let i = 0; i < binaryKey.length; i++) {
      keyBytes[i] = binaryKey.charCodeAt(i);
    }

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      keyBytes.buffer,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(unsignedToken)
    );

    const signatureBytes = new Uint8Array(signature);
    let signatureBinary = '';
    for (let i = 0; i < signatureBytes.byteLength; i++) {
      signatureBinary += String.fromCharCode(signatureBytes[i]);
    }
    const encodedSignature = btoa(signatureBinary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const jwt = `${unsignedToken}.${encodedSignature}`;

    // Exchange assertion for access token
    const tokenRes = await fetch(tokenUri, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Failed to exchange service account JWT for access token: ${err}`);
    }

    const tokenData = (await tokenRes.json()) as { access_token: string; expires_in?: number };
    const expiresIn = tokenData.expires_in || 3600;
    this.cachedToken = {
      email: serviceAccount.client_email,
      token: tokenData.access_token,
      expiresAt: now + expiresIn,
    };
    return tokenData.access_token;
  }

  /**
   * Converts an ArrayBuffer to a base64 encoded string safely in chunks.
   */
  private static bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  /**
   * Downloads an attachment image from Google Chat as base64 string.
   * Prioritizes the official Google Chat media API (/v1/media/{resourceName}?alt=media)
   * with service account authentication.
   */
  static async downloadAttachmentAsBase64(
    attachmentOrUri: string | ChatAttachment,
    serviceAccountJson?: string
  ): Promise<{ base64: string; mimeType: string }> {
    const attachment: ChatAttachment = typeof attachmentOrUri === 'string'
      ? { downloadUri: attachmentOrUri }
      : attachmentOrUri;

    // 1. Official Google Chat API Media download if attachmentDataRef.resourceName is present
    if (attachment.attachmentDataRef?.resourceName && serviceAccountJson) {
      try {
        const sa = JSON.parse(serviceAccountJson) as ServiceAccountCredentials;
        const accessToken = await this.getServiceAccountAccessToken(sa);
        const resourceName = encodeURIComponent(attachment.attachmentDataRef.resourceName);
        const mediaUrl = `https://chat.googleapis.com/v1/media/${resourceName}?alt=media`;

        const res = await fetch(mediaUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (!contentType.includes('text/html')) {
            const arrayBuffer = await res.arrayBuffer();
            const base64 = this.bufferToBase64(arrayBuffer);
            const mimeType = attachment.contentType || (contentType.includes('application/octet-stream') ? 'image/jpeg' : contentType);
            return { base64, mimeType };
          }
        } else {
          console.warn(`[GoogleChatMedia] Media API returned ${res.status}: ${await res.text()}`);
        }
      } catch (err) {
        console.warn('[GoogleChatMedia] Failed to download via attachmentDataRef:', err);
      }
    }

    // 2. Fetch via attachment.name metadata if present
    if (attachment.name && serviceAccountJson) {
      try {
        const sa = JSON.parse(serviceAccountJson) as ServiceAccountCredentials;
        const accessToken = await this.getServiceAccountAccessToken(sa);
        const metaRes = await fetch(`https://chat.googleapis.com/v1/${attachment.name}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (metaRes.ok) {
          const metaData = (await metaRes.json()) as any;
          const resourceName = metaData.attachmentDataRef?.resourceName;
          if (resourceName) {
            const mediaUrl = `https://chat.googleapis.com/v1/media/${encodeURIComponent(resourceName)}?alt=media`;
            const mediaRes = await fetch(mediaUrl, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (mediaRes.ok) {
              const arrayBuffer = await mediaRes.arrayBuffer();
              const base64 = this.bufferToBase64(arrayBuffer);
              const mimeType = attachment.contentType || metaData.contentType || 'image/jpeg';
              return { base64, mimeType };
            }
          }
        }
      } catch (err) {
        console.warn('[GoogleChatMedia] Failed to resolve via attachment.name:', err);
      }
    }

    // 3. Fallback: try downloadUri or thumbnailUri directly
    const fallbackUri = attachment.downloadUri || attachment.thumbnailUri;
    if (fallbackUri) {
      let res = await fetch(fallbackUri);

      // If pre-signed fetch gets 401/403 and serviceAccountJson is available, try with bearer token
      if (!res.ok && (res.status === 401 || res.status === 403) && serviceAccountJson) {
        try {
          const sa = JSON.parse(serviceAccountJson) as ServiceAccountCredentials;
          const accessToken = await this.getServiceAccountAccessToken(sa);
          res = await fetch(fallbackUri, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
        } catch (err) {
          console.warn('[GoogleChatMedia] Fallback bearer fetch error:', err);
        }
      }

      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        // If Google redirected to HTML login page, it is not an image
        if (contentType.includes('text/html')) {
          throw new Error('Google Chat pre-signed URL redirected to Google Accounts login HTML. Use attachmentDataRef or upload image directly.');
        }

        const arrayBuffer = await res.arrayBuffer();
        const base64 = this.bufferToBase64(arrayBuffer);
        const mimeType = attachment.contentType || contentType || 'image/jpeg';
        return { base64, mimeType };
      }

      throw new Error(`Failed to download attachment from ${fallbackUri} (status ${res.status})`);
    }

    throw new Error('No valid download URL or attachmentDataRef found on attachment.');
  }

  /**
   * Posts a message or card to a space/thread using Google Chat REST API with service account credentials.
   */
  static async postMessage(
    spaceName: string,
    messagePayload: { text?: string; cardsV2?: any[]; thread?: { name: string } },
    serviceAccountJson?: string
  ): Promise<any> {
    if (!serviceAccountJson) return null;
    try {
      const sa = JSON.parse(serviceAccountJson) as ServiceAccountCredentials;
      const accessToken = await this.getServiceAccountAccessToken(sa);
      const url = `https://chat.googleapis.com/v1/${spaceName}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messagePayload),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`[GoogleChatMedia] postMessage error (${res.status}):`, err);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error('[GoogleChatMedia] postMessage failed:', err);
      return null;
    }
  }

  /**
   * Updates an existing message or card in place using Google Chat REST API with service account credentials.
   */
  static async patchMessage(
    messageName: string,
    messagePayload: { text?: string; cardsV2?: any[] },
    serviceAccountJson?: string
  ): Promise<any> {
    if (!serviceAccountJson) return null;
    try {
      const sa = JSON.parse(serviceAccountJson) as ServiceAccountCredentials;
      const accessToken = await this.getServiceAccountAccessToken(sa);
      const updateMask = messagePayload.cardsV2 ? 'cardsV2' : 'text';
      const url = `https://chat.googleapis.com/v1/${messageName}?updateMask=${updateMask}`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messagePayload),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`[GoogleChatMedia] patchMessage error (${res.status}):`, err);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error('[GoogleChatMedia] patchMessage failed:', err);
      return null;
    }
  }
}

