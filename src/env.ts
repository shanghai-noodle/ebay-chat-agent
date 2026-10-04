export interface CloudflareBindings {
  // KV Namespace
  DRAFTS_KV: KVNamespace;

  // Environment variables
  EBAY_ENV: 'sandbox' | 'production';
  EBAY_API_BASE: string;
  EBAY_EPS_URL: string;
  EBAY_MARKETPLACE_ID: string;

  // Secrets (configured via wrangler secret put)
  GEMINI_API_KEY: string;
  EBAY_APP_ID: string;
  EBAY_CERT_ID: string;
  EBAY_DEV_ID: string;
  EBAY_USER_TOKEN: string; // Or refresh token
  
  // Optional policy overrides (or queried from eBay account)
  EBAY_FULFILLMENT_POLICY_ID?: string;
  EBAY_PAYMENT_POLICY_ID?: string;
  EBAY_RETURN_POLICY_ID?: string;

  // Google Service Account JSON string for Chat Attachment downloading
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
}
