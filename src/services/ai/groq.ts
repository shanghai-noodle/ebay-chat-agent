import { ListingDraft } from '../../types/draft';
import { SellerInventorySummary } from '../ebay/trading';
import {
  AIService,
  ExtractedItemAnalysis,
  SellerChatResponse,
  SheetCustomizationIntent,
} from './types';

export class GroqService implements AIService {
  readonly providerName = 'groq';
  private apiKey: string;
  private visionModel: string;
  private chatModel: string;
  private fallbackChatModels: string[];

  constructor(
    apiKey: string,
    options?: { visionModel?: string; chatModel?: string }
  ) {
    this.apiKey = apiKey;
    this.visionModel = options?.visionModel || 'qwen/qwen3.8-27b';
    this.chatModel = options?.chatModel || 'openai/gpt-oss-120b';
    this.fallbackChatModels = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
  }

  /**
   * Helper to execute a chat completion request against Groq OpenAI-compatible API.
   */
  private async callGroqChat(
    messages: any[],
    model: string,
    responseFormat: { type: 'json_object' | 'text' } = { type: 'json_object' },
    maxTokens?: number,
    timeoutMs: number = 35000
  ): Promise<string> {
    const payload: any = {
      model,
      messages,
      response_format: responseFormat,
    };
    if (typeof maxTokens === 'number') {
      payload.max_tokens = maxTokens;
    }

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = res.statusText;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson?.error?.message || errMsg;
      } catch {
        errMsg = errText || errMsg;
      }

      if (res.status === 429) {
        throw new Error(
          `Groq Rate Limit Exceeded (429): ${errMsg}. Free tier limits apply; please wait a moment before sending another request.`
        );
      }
      if (res.status === 401) {
        throw new Error(`Groq Authentication Failed (401): ${errMsg}. Please verify your GROQ_API_KEY.`);
      }

      throw new Error(`Groq API error (${res.status}): ${errMsg}`);
    }

    const data = (await res.json()) as any;
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`Groq model ${model} returned an empty response.`);
    }

    return content;
  }

  /**
   * Cleans potential markdown blocks (```json ... ```) from JSON string.
   */
  private cleanJsonString(raw: string): string {
    let clean = raw.trim();
    if (clean.startsWith('```json')) {
      clean = clean.replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    } else if (clean.startsWith('```')) {
      clean = clean.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }
    return clean.trim();
  }

  /**
   * Analyze one or more product images using Groq Vision (e.g. qwen/qwen3.8-27b).
   */
  async analyzeItemImages(
    images: Array<{ base64: string; mimeType?: string }>,
    userHint?: string
  ): Promise<ExtractedItemAnalysis> {
    const hintText = userHint && userHint.trim() ? `\nUser notes/instructions: "${userHint.trim()}"\n` : '';
    const systemPrompt = `You are an expert eBay seller assistant. Analyze the uploaded product image(s) to create an accurate eBay listing draft matching the seller's signature live store style.

CRITICAL INSTRUCTIONS:
1. TITLE FORMAT:
   - For Brand New items: Prefix with 'NIB - ' (e.g. 'NIB - Transformers Prime VEHICON Deluxe Class First Edition').
   - For Like New / Open Box items: Prefix with 'Open Box - '.
   - For Used items: Prefix with 'Used - ' or '[AS IS] ' if damaged/for parts.
   - Follow with: [Franchise / Brand] [Character / Model] [Class / Series / Scale] [Key Specs / Edition].
   - Strictly 80 characters or fewer. Never use fluff like 'L@@K' or 'WOW'.

2. DESCRIPTION FORMAT (HTML):
   Format as clean HTML adhering to the seller's signature 3-part layout:
   <div>
     <ul>
       <li>[Condition statement, e.g. "Brand new AUTHENTIC [Item Name]" or "Authentic [Item Name] in excellent condition"]</li>
       <li>[Package state, e.g. "New in package SEALED never opened." or packaging details]</li>
       <li>[Packaging/item wear note, e.g. "The box shows minor shelf and storage wear and tear." or specific flaw notes]</li>
       <li>Stored in smoke free, pet free and weather controlled storage.</li>
       <li>Item shipped from US California.</li>
     </ul>
   </div>
   <br>
   <div>
     <b>Note:</b>
     <ul>
       <li>You are buying from an authentic collectible seller. All of the items are carefully inspected to ensure quality and if there are any defects, they will be individually noted.</li>
       <li>Item may have minor shelf wear on the box.</li>
       <li>Item may not be suitable to be treated as a toy due to its rarity.</li>
     </ul>
   </div>
   <br>
   <div><b>Enjoy and good luck with your collection!</b></div>

3. ITEM SPECIFICS:
   - Single value for primary fields (Brand, Franchise, Character, Type, Model).

4. PRICING & SHIPPING:
   - Realistic pricing in USD.
   - Default shippingCost is 0 (Free shipping) unless user requested otherwise.${hintText}

5. MERCHANDISE & LOGO ITEMS:
   - Even if the image shows a logo, graphic, digital art, sticker, card, or collectible emblem, always treat it as a collectible merchandise item and produce a complete listing draft in JSON without refusal.

You MUST output your response ONLY as a valid JSON object matching this exact structure:
{
  "title": "string (under 80 chars)",
  "categoryKeywords": "string (e.g. Action Figures, Collectibles)",
  "condition": "NEW" | "LIKE_NEW" | "USED_EXCELLENT" | "USED_GOOD" | "FOR_PARTS_OR_NOT_WORKING",
  "conditionDescription": "string",
  "aspects": { "Brand": ["..."], "Character": ["..."] },
  "descriptionHtml": "string (clean HTML)",
  "suggestedPrice": { "low": number, "recommended": number, "high": number },
  "marketIntelligence": {
    "activeCompRange": "string (e.g. $45 - $65)",
    "recentSoldRange": "string (e.g. $38 - $52)",
    "competitorSummary": "string"
  },
  "shippingCost": number
}`;

    // Select up to 4 images
    const selectedImages = images.slice(0, 4);
    const userContent: any[] = [
      { type: 'text', text: systemPrompt },
    ];

    for (const img of selectedImages) {
      const mime = img.mimeType || 'image/jpeg';
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${mime};base64,${img.base64}`,
        },
      });
    }

    try {
      const rawJson = await this.callGroqChat(
        [{ role: 'user', content: userContent }],
        this.visionModel,
        { type: 'json_object' },
        650,
        45000
      );

      const parsed = JSON.parse(this.cleanJsonString(rawJson));

      // Standardize categoryKeywords if returned as array
      if (Array.isArray(parsed.categoryKeywords)) {
        parsed.categoryKeywords = parsed.categoryKeywords.join(', ');
      }

      return parsed as ExtractedItemAnalysis;
    } catch (err: any) {
      console.error('[Groq] analyzeItemImages failed:', err);
      throw new Error(`Groq Vision failed: ${err.message || err}`);
    }
  }

  /**
   * Convenience single image analyzer.
   */
  async analyzeItemImage(
    imageBase64: string,
    mimeType: string = 'image/jpeg'
  ): Promise<ExtractedItemAnalysis> {
    return this.analyzeItemImages([{ base64: imageBase64, mimeType }]);
  }

  /**
   * Refine a current listing draft based on user conversational commands.
   */
  async refineListing(
    currentDraft: ListingDraft,
    userFeedback: string
  ): Promise<Partial<ListingDraft>> {
    const prompt = `The user is conversing with you to adjust their eBay listing draft.
Current Draft:
${JSON.stringify(
  {
    title: currentDraft.title,
    price: currentDraft.price,
    shippingCost: currentDraft.shippingCost ?? 0,
    condition: currentDraft.condition,
    conditionDescription: currentDraft.conditionDescription,
    aspects: currentDraft.aspects,
    descriptionHtml: currentDraft.descriptionHtml,
  },
  null,
  2
)}

User Instruction: "${userFeedback}"

Update the draft fields based on the user's instruction. If the user mentions a new price, shipping fee, title tweak, or condition adjustment, reflect that accurately.
Return ONLY a valid JSON object containing the updated fields:
{
  "title"?: string,
  "price"?: number,
  "shippingCost"?: number,
  "condition"?: "NEW" | "LIKE_NEW" | "USED_EXCELLENT" | "USED_GOOD" | "FOR_PARTS_OR_NOT_WORKING",
  "conditionDescription"?: string,
  "descriptionHtml"?: string,
  "aspects"?: Record<string, string[]>
}`;

    const rawJson = await this.callGroqChat(
      [{ role: 'user', content: prompt }],
      this.chatModel,
      { type: 'json_object' },
      350,
      25000
    );

    return JSON.parse(this.cleanJsonString(rawJson));
  }

  /**
   * Multi-turn conversational relay to Groq.
   * Handles user questions, market pricing inquiries, and draft adjustments.
   * If Groq fails, returns a clear alert message directly to the seller in chat.
   */
  async chatWithSeller(
    userMessage: string,
    currentDraft?: ListingDraft | null,
    inventorySummary?: SellerInventorySummary | null
  ): Promise<SellerChatResponse> {
    let draftContext = 'There is currently no active listing draft in progress.';
    if (currentDraft) {
      draftContext = `Active Listing Draft in Progress:
- Title: "${currentDraft.title}"
- Category: ${currentDraft.categoryName} (${currentDraft.categoryId})
- Current Price: $${currentDraft.price} ${currentDraft.currency}
- Shipping Cost: $${currentDraft.shippingCost ?? 0}
- Condition: ${currentDraft.condition} (${currentDraft.conditionDescription || 'No description'})
- Image Count: ${currentDraft.imageUrls.length} photo(s) attached
- Aspects: ${JSON.stringify(currentDraft.aspects || {})}`;
    }

    let inventoryContext = 'Seller Active Inventory: No inventory loaded.';
    if (inventorySummary && inventorySummary.totalCount > 0) {
      inventoryContext = `Seller Active Inventory (${inventorySummary.totalCount} active listings):
- Total Catalog Retail Value: $${inventorySummary.totalValue.toFixed(2)} USD
- Average Listing Price: $${inventorySummary.averagePrice.toFixed(2)} USD
- Dominant Categories: ${Object.entries(inventorySummary.categoryCounts || {})
        .slice(0, 5)
        .map(([cat, count]) => `${cat} (${count})`)
        .join(', ')}
- High-Value Items (Comps & CMA Reference):
${inventorySummary.items
  .slice(0, 15)
  .map(
    (item, idx) =>
      `  ${idx + 1}. [${item.itemId}] "${item.title}" — $${item.price.toFixed(2)} | Condition: ${item.condition} | URL: ${item.listingUrl}`
  )
  .join('\n')}`;
    }

    const systemPrompt = `You are the AI assistant for an expert eBay Store Manager.
You communicate directly with the seller in Google Chat.

Current Context:
${draftContext}

${inventoryContext}

Seller's Latest Message: "${userMessage}"

Tasks:
1. If the user asks general questions about their inventory, portfolio value, top items, or market research, provide an intelligent, accurate answer using the inventory data above.
2. If the user asks to adjust draft fields (price, title, shipping cost, condition, description), update draftUpdates and set hasDraftUpdates = true.
3. If the user asks to export, generate, sync, or view their inventory or market research report in Google Sheets, set isSheetExportRequested = true.
4. If the user requests layout modifications for their Google Sheet report (such as moving columns, adding thumbnail or item link columns, reordering columns, removing columns, or color-coding), populate the sheetCustomization object.
5. Format your replyText cleanly for Google Chat with bold headers, bullet points, and neat spacing.

You MUST return your answer ONLY as a JSON object matching this structure:
{
  "replyText": "string (conversational response for Google Chat)",
  "hasDraftUpdates": boolean,
  "draftUpdates"?: {
    "title"?: string,
    "price"?: number,
    "shippingCost"?: number,
    "condition"?: "NEW" | "LIKE_NEW" | "USED_EXCELLENT" | "USED_GOOD" | "FOR_PARTS_OR_NOT_WORKING",
    "conditionDescription"?: string,
    "descriptionHtml"?: string,
    "aspects"?: Record<string, string[]>
  },
  "isInventoryInquiry"?: boolean,
  "isSheetExportRequested"?: boolean,
  "sheetCustomization"?: {
    "moveColumns"?: Array<{ "column": string, "toPosition": string | number }>,
    "columnsToAdd"?: Array<{ "column": string, "position"?: string | number }>,
    "columnsToRemove"?: string[],
    "colorCodeColumns"?: string[],
    "rowHeight"?: number
  }
}`;

    let lastError: Error | null = null;
    for (const model of this.fallbackChatModels) {
      try {
        const rawJson = await this.callGroqChat(
          [{ role: 'user', content: systemPrompt }],
          model,
          { type: 'json_object' },
          850,
          30000
        );

        return JSON.parse(this.cleanJsonString(rawJson)) as SellerChatResponse;
      } catch (err: any) {
        lastError = err;
        console.warn(`[Groq] Model ${model} failed: ${err.message}. Trying next candidate within Groq.`);
      }
    }

    console.error('[Groq] All Groq chat models failed:', lastError);
    const isRateLimit = /rate limit|quota|429/i.test(lastError?.message || '');
    const alertMessage = isRateLimit
      ? `⚠️ **Groq Free Tier Rate Limit Reached**\n\nThe Groq API request or token quota has been temporarily exhausted. Please wait 1–2 minutes for the limit to reset before issuing your next request.\n\n*Error details: ${lastError?.message}*`
      : `⚠️ **Groq API Error**\n\nUnable to process your request via Groq: ${lastError?.message || 'Unknown error'}.\n\nPlease check your Groq API status or try again shortly.`;

    return {
      replyText: alertMessage,
      hasDraftUpdates: false,
      isInventoryInquiry: false,
      isSheetExportRequested: false,
    };
  }
}
