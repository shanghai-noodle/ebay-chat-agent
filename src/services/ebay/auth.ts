export interface EbayOAuthCredentials {
  apiBase: string; // https://api.sandbox.ebay.com
  appId: string;
  certId: string;
}

export class EbayAuthService {
  /**
   * Refreshes an eBay OAuth User Access Token using a Refresh Token.
   */
  static async refreshUserAccessToken(
    refreshToken: string,
    creds: EbayOAuthCredentials,
    scopes: string[] = ['https://api.ebay.com/oauth/api_scope/sell.inventory']
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const basicAuth = btoa(`${creds.appId}:${creds.certId}`);
    const tokenUrl = `${creds.apiBase}/identity/v1/oauth2/token`;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to refresh eBay user token: ${err}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }
}
