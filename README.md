# eBay Listing Agent for Google Chat

An AI-powered eBay listing agent running on Cloudflare Workers. Upload photos in Google Chat, converse with the agent to refine details, and publish directly to eBay.

## Features

- ⚡ **Cloudflare Workers (Edge Runtime)**: Instant response times, serverless scaling, zero idle cost.
- 👁️ **Gemini Multimodal Vision (`gemini-3.8-flash`)**: Auto-generates 80-char eBay SEO titles, extracts item specifics (Brand, Model, Size, Color), evaluates condition flaws, and drafts HTML descriptions.
- 🖼️ **Direct eBay Picture Services (EPS)**: Streams photos directly to `i.ebayimg.com` without needing intermediary cloud storage buckets.
- 💬 **Google Chat Cards v2**: Interactive review cards with 1-click publishing or conversational adjustments.
- 📦 **eBay Sell Inventory & Taxonomy APIs**: Category mapping, inventory management, policy resolution, and live offer publishing.

---

## Quick Setup

### 1. Prerequisites
- Node.js >= 20
- Cloudflare account with Wrangler CLI (`npx wrangler login`)
- eBay Developer Account (Sandbox enabled)
- Google Cloud Project with Google Chat API enabled

### 2. Configure Cloudflare KV
Create the KV namespace for session/draft persistence:
```bash
npx wrangler kv:namespace create DRAFTS_KV
```
Copy the generated `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 3. Set Secrets in Cloudflare
```bash
# Gemini
npx wrangler secret put GEMINI_API_KEY

# eBay Developer Sandbox
npx wrangler secret put EBAY_APP_ID
npx wrangler secret put EBAY_CERT_ID
npx wrangler secret put EBAY_DEV_ID
npx wrangler secret put EBAY_USER_TOKEN

# Google Service Account (Single line JSON string)
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
```

### 4. Local Development
```bash
npm install
npm run dev
```

### 5. Deployed Cloudflare Endpoint
Your worker is currently **deployed and active** at:
```
https://ebay-chat-agent.tommyguc.workers.dev
```

### 6. Configure Google Chat App
1. Go to Google Cloud Console (Project: `shanghainoodle`) > **Google Chat API** > **Configuration**.
2. Set **App name**: `eBay Listing Agent`.
3. Set **Interactive features**: Check *Receive 1:1 messages* and *Join spaces and group conversations*.
4. Set **Connection settings**: Select *HTTP endpoint* and paste:
   ```
   https://ebay-chat-agent.tommyguc.workers.dev
   ```
5. Set **Visibility**: Allow specific users (add `tommyguc@gmail.com`).
6. Click **Save** and start chatting with your bot in Google Chat!
