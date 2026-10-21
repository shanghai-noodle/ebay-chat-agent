import { ListingDraft } from '../types/draft';
import { SellerInventorySummary } from './ebay/trading';

export interface ExtractedItemAnalysis {
  title: string;
  categoryKeywords: string;
  condition: 'NEW' | 'LIKE_NEW' | 'USED_EXCELLENT' | 'USED_GOOD' | 'FOR_PARTS_OR_NOT_WORKING';
  conditionDescription: string;
  aspects: Record<string, string[]>;
  descriptionHtml: string;
  suggestedPrice: {
    low: number;
    recommended: number;
    high: number;
  };
  marketIntelligence?: {
    activeCompRange?: string;
    recentSoldRange?: string;
    competitorSummary?: string;
  };
  shippingCost?: number;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'SEO optimized eBay title (under 80 chars). Default to seller style: prefix with "NIB - " if new, "Open Box - " if like new, or "Used - " / "[AS IS] " if used, followed by Franchise/Brand, Character/Model, Class/Series, key features.',
    },
    categoryKeywords: {
      type: 'string',
      description: 'Keywords to look up the eBay category tree, e.g. "Action Figures" or "Men\'s Athletic Shoes".',
    },
    condition: {
      type: 'string',
      enum: ['NEW', 'LIKE_NEW', 'USED_EXCELLENT', 'USED_GOOD', 'FOR_PARTS_OR_NOT_WORKING'],
      description: 'The estimated eBay condition grade.',
    },
    conditionDescription: {
      type: 'string',
      description: 'A brief description of any wear, flaws, marks, or confirms good condition.',
    },
    aspects: {
      type: 'object',
      description: 'Item specifics as key-value pairs where values are arrays of strings (e.g. Brand, Model, Color, Character, Franchise). Brand, Franchise, Type, Character must have only 1 value.',
      additionalProperties: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    descriptionHtml: {
      type: 'string',
      description: 'Clean HTML description following seller signature 3-part layout: 1. Core item bullets (Authentic statement, package sealed state, box wear note, smoke/pet free storage, shipped from California). 2. Seller quality note (authenticity guarantee, inspection promise). 3. Sign-off: "Enjoy and good luck with your collection!"',
    },
    suggestedPrice: {
      type: 'object',
      properties: {
        low: { type: 'number', description: 'Low estimate price in USD' },
        recommended: { type: 'number', description: 'Recommended starting price in USD' },
        high: { type: 'number', description: 'High estimate price in USD' },
      },
      required: ['low', 'recommended', 'high'],
    },
    marketIntelligence: {
      type: 'object',
      properties: {
        activeCompRange: {
          type: 'string',
          description: 'Estimated price range that other sellers are currently listing this item for on eBay (e.g. "$45 - $65").',
        },
        recentSoldRange: {
          type: 'string',
          description: 'Estimated price range for recent confirmed sold items in comparable condition (e.g. "$38 - $52").',
        },
        competitorSummary: {
          type: 'string',
          description: 'Summary of what other people are selling the item for, competitor pricing, and market demand tips.',
        },
      },
      required: ['activeCompRange', 'recentSoldRange', 'competitorSummary'],
    },
    shippingCost: {
      type: 'number',
      description: 'Shipping cost in USD. Default is 0 (Free shipping), unless the user explicitly requested a specific shipping fee.',
    },
  },
  required: ['title', 'categoryKeywords', 'condition', 'conditionDescription', 'aspects', 'descriptionHtml', 'suggestedPrice', 'marketIntelligence'],
};

export interface SheetCustomizationIntent {
  moveColumns?: Array<{ column: string; toPosition: string | number }>;
  columnsToAdd?: Array<{ column?: string; id?: string; title?: string; position?: string | number }>;
  columnsToRemove?: string[];
  colorCodeColumns?: string[];
  rowHeight?: number;
}

export class GeminiService {
  private apiKey: string;
  private listingModels = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'];
  private queryModels = ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-flash-latest'];

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async callInteractionsApi(payload: any, models: string[] = this.listingModels): Promise<string> {
    let lastError: Error | undefined;

    for (const model of models) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions?key=${this.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, model }),
          signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as any;
          const msg = errData?.error?.message || res.statusText;
          lastError = new Error(`Gemini ${model} failed (${res.status}): ${msg}`);
          console.warn(`[Gemini] ${model} error: ${msg}. Attempting fallback model.`);
          continue;
        }

        const data = (await res.json()) as any;
        const textStep = data.steps?.find((s: any) => s.type === 'model_output');
        const outputText = textStep?.content?.[0]?.text || data.output_text;

        if (!outputText) {
          lastError = new Error(`Gemini ${model} did not return any output text.`);
          continue;
        }

        console.log(`[Gemini] Successfully generated response using model: ${model}`);
        return outputText;
      } catch (err: any) {
        lastError = err;
      }
    }

    throw lastError || new Error('All Gemini candidate models failed to process request.');
  }

  /**
   * Analyze one or more images uploaded by the user to extract item details for eBay listing.
   */
  async analyzeItemImages(
    images: Array<{ base64: string; mimeType?: string }>,
    userHint?: string
  ): Promise<ExtractedItemAnalysis> {
    const hintText = userHint && userHint.trim() ? `\nUser notes/instructions: "${userHint.trim()}"\n` : '';
    const prompt = `You are an expert eBay seller assistant. Analyze the uploaded product image(s) to create an accurate eBay listing draft matching the seller's signature live store style.

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
   *(If the item is general merchandise/electronics rather than toys/collectibles, adapt the note bullets appropriately while retaining the authentic seller inspection promise, smoke/pet-free storage, and California shipping).*

3. ITEM SPECIFICS:
   - Single value for primary fields (Brand, Franchise, Character, Type, Model).

4. PRICING & SHIPPING:
   - Realistic pricing in USD.
   - Default shippingCost is 0 (Free shipping) unless user requested otherwise.${hintText}`;

    // Pass up to 4 images to Gemini to provide rich context without exceeding payload limits
    const selectedImages = images.slice(0, 4);
    const imageInputs = selectedImages.map((img) => ({
      type: 'image',
      data: img.base64,
      mime_type: img.mimeType || 'image/jpeg',
    }));

    const outputText = await this.callInteractionsApi({
      input: [
        { type: 'text', text: prompt },
        ...imageInputs,
      ],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: EXTRACTION_SCHEMA,
      },
    });

    return JSON.parse(outputText) as ExtractedItemAnalysis;
  }

  /**
   * Analyze a single image uploaded by the user (backward compatibility).
   */
  async analyzeItemImage(imageBase64: string, mimeType: string = 'image/jpeg'): Promise<ExtractedItemAnalysis> {
    return this.analyzeItemImages([{ base64: imageBase64, mimeType }]);
  }

  /**
   * Refine a current listing draft based on user conversational commands (e.g. "change price to $45", "shipping $5").
   */
  async refineListing(currentDraft: ListingDraft, userFeedback: string): Promise<Partial<ListingDraft>> {
    const prompt = `The user is conversing with you to adjust their eBay listing draft.
Current Draft:
${JSON.stringify({
  title: currentDraft.title,
  price: currentDraft.price,
  shippingCost: currentDraft.shippingCost ?? 0,
  condition: currentDraft.condition,
  conditionDescription: currentDraft.conditionDescription,
  aspects: currentDraft.aspects,
  descriptionHtml: currentDraft.descriptionHtml,
}, null, 2)}

User Instruction: "${userFeedback}"

Update the draft fields based on the user's instruction. If the user mentions a new price, shipping fee, title tweak, or condition adjustment, reflect that accurately.`;

    const outputText = await this.callInteractionsApi({
      input: [{ type: 'text', text: prompt }],
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            price: { type: 'number' },
            shippingCost: { type: 'number', description: 'Shipping cost in USD (0 for free shipping)' },
            condition: {
              type: 'string',
              enum: ['NEW', 'LIKE_NEW', 'USED_EXCELLENT', 'USED_GOOD', 'FOR_PARTS_OR_NOT_WORKING'],
            },
            conditionDescription: { type: 'string' },
            descriptionHtml: { type: 'string' },
            aspects: {
              type: 'object',
              additionalProperties: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    });

    return JSON.parse(outputText);
  }

  /**
   * Multi-turn conversational relay to Gemini.
   * Handles user questions (market pricing, item rarity, advice) and detects draft edits.
   */
  async chatWithSeller(
    userMessage: string,
    currentDraft?: ListingDraft | null,
    inventorySummary?: SellerInventorySummary | null
  ): Promise<{
    replyText: string;
    hasDraftUpdates: boolean;
    draftUpdates?: Partial<ListingDraft>;
    isInventoryInquiry?: boolean;
    isSheetExportRequested?: boolean;
    sheetCustomization?: SheetCustomizationIntent;
  }> {
    const draftContext = currentDraft
      ? `Active Listing Draft in Current Thread:
- Title: "${currentDraft.title}"
- Condition: ${currentDraft.condition} (${currentDraft.conditionDescription || 'No flaws'})
- Price: $${currentDraft.price.toFixed(2)} USD
- Shipping: ${(!currentDraft.shippingCost || currentDraft.shippingCost <= 0) ? 'Free Shipping' : '$' + currentDraft.shippingCost.toFixed(2)}
- Category: ${currentDraft.categoryName || 'General'} (ID: ${currentDraft.categoryId || 'N/A'})
- Aspects: ${JSON.stringify(currentDraft.aspects || {})}
${currentDraft.marketIntelligence ? `- Market Comps: Active ${currentDraft.marketIntelligence.activeCompRange || 'N/A'}, Sold ${currentDraft.marketIntelligence.recentSoldRange || 'N/A'} - ${currentDraft.marketIntelligence.competitorSummary || ''}` : ''}`
      : 'No active listing draft in this thread yet.';

    let inventoryBlock = '';
    if (inventorySummary && inventorySummary.totalCount > 0) {
      const topItemsStr = inventorySummary.topValuable
        .map((i, idx) => `  ${idx + 1}. #${i.itemId}: "${i.title}" — $${i.price.toFixed(2)} [${i.categoryGroup}]`)
        .join('\n');

      const allItemsList = inventorySummary.items
        .map(
          (i) =>
            `- #${i.itemId}: "${i.title}" | $${i.price.toFixed(2)} | [${i.categoryGroup || 'General'}] | ${i.condition || 'MISB'} | URL: ${i.listingUrl}`
        )
        .join('\n');

      inventoryBlock = `
SELLER'S CURRENT ACTIVE EBAY INVENTORY:
• Total Active Listings: ${inventorySummary.totalCount} items
• Total Portfolio Retail Value: $${inventorySummary.totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
• Average Listing Price: $${inventorySummary.averagePrice.toFixed(2)} USD
• Categories Breakdown: ${Object.entries(inventorySummary.categoryCounts).map(([cat, count]) => `${cat} (${count})`).join(', ')}
• Top 5 Most Valuable Listings:
${topItemsStr}

FULL ACTIVE LISTINGS CATALOG:
${allItemsList}
`;
    }

    const systemPrompt = `You are an expert eBay Selling Assistant, inventory strategist, and ecommerce advisor.
You are conversing with the seller "ly014132", an authentic California seller specializing in collectibles, figures, die-cast models, and rare merchandise.

${draftContext}
${inventoryBlock}

User Message: "${userMessage}"

Instructions:
1. You have complete, direct access to the seller's active eBay inventory provided above.
2. If the user asks to check, review, list, analyze, audit, or summarize their listed items:
   - Provide a high-value, professional inventory analysis using the real data:
     * Overview: Total listings (${inventorySummary?.totalCount || 0} items) and total portfolio value ($${inventorySummary?.totalValue.toFixed(2) || '0.00'} USD).
     * Category Distribution: Break down their collections (e.g. Transformers, Die-Cast & Vehicles, Disney Pixar, LEGO & Sets).
     * Key Highlights: Point out their most valuable pieces (e.g. Takara Prime AM-24 Silas Breakdown, MP-10 Optimus Prime, Disney Cars Lightning McQueen, etc.).
     * Specific Item Lookups: If they ask about a specific item (by character, title, or Item ID like 237131227545), give detailed stats and advice on that specific listing.
     * Filtering: If they ask for items matching a filter (e.g. "items under $50", "list my Transformers", "what Disney items do I have?"), filter and list those exact items with their prices and links.
     * Actionable Advice: Note pricing health, sealed condition status (MISB/NIB), and tips to maximize sell-through.
3. If the user asks to create, export, generate, or report their listings/inventory in a Google Sheet or spreadsheet (e.g. "create a google sheet", "export to sheets", "spreadsheet for reporting", "generate sheet"):
   - Acknowledge that you are generating their live Google Sheet report with all active listings, pricing formulas, and executive portfolio summary.
   - Set "isSheetExportRequested": true.
4. If they ask about competitor prices or market comps, give realistic market data and eBay trends.
5. If the user's message asks to update/modify the draft (e.g. price change, shipping cost, title change, condition change, or description update):
   - Set "hasDraftUpdates": true
   - In "draftUpdates", provide only the updated fields (e.g. { "price": 45, "shippingCost": 0 }).
   - Otherwise, set "hasDraftUpdates": false.
6. If the user asks to modify, rearrange, customize, format, or refresh the Google Sheet layout:
   - For example: "move the item link to the first column", "add a second column using item thumbnail", "color code Competitiveness Rating column", "add Gemini Suggested price adjustment", "remove category column":
   - Set "isSheetExportRequested": true
   - Populate "sheetCustomization" with the structured changes:
     * moveColumns: e.g. [{ "column": "item link", "toPosition": "first" }]
     * columnsToAdd: e.g. [{ "column": "item thumbnail", "position": "second" }]
     * columnsToRemove: e.g. ["category"]
     * colorCodeColumns: e.g. ["Competitiveness Rating"]
     * rowHeight: e.g. 56 if thumbnails are included
   - In your replyText, confirm specifically what modifications and columns are being applied and updated in their Google Sheet.
7. Format your response cleanly for Google Chat with bold headers, bullet points, and neat spacing.`;

    try {
      const outputText = await this.callInteractionsApi({
        input: [{ type: 'text', text: systemPrompt }],
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: {
            type: 'object',
            properties: {
              replyText: {
                type: 'string',
                description: 'The conversational response to display to the user in Google Chat.',
              },
              isInventoryInquiry: {
                type: 'boolean',
                description: 'True if the user asked about, inquired about, or requested analysis on their eBay inventory or listed items.',
              },
              isSheetExportRequested: {
                type: 'boolean',
                description: 'True if the user asked to create, export, generate, or report their inventory in a Google Sheet or spreadsheet, or requested sheet modifications.',
              },
              sheetCustomization: {
                type: 'object',
                description: 'Detected layout customization commands for the Google Sheet report, such as reordering columns, adding/moving thumbnail or link columns, removing columns, or color-coding columns.',
                properties: {
                  moveColumns: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        column: { type: 'string', description: 'Name or identifier of column to move, e.g. "item link", "listingUrl", "thumbnail", "title"' },
                        toPosition: { type: 'string', description: 'Target position, e.g. "first", "second", "1", "2", "last"' },
                      },
                      required: ['column', 'toPosition'],
                    },
                  },
                  columnsToAdd: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        column: { type: 'string', description: 'Column to add, e.g. "thumbnail", "suggestedPrice", "suggestedAdjustment", "itemDescription"' },
                        position: { type: 'string', description: 'Position to place new column, e.g. "first", "second", "2", "last"' },
                      },
                      required: ['column'],
                    },
                  },
                  columnsToRemove: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Columns to remove from the sheet',
                  },
                  colorCodeColumns: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Columns to apply conditional color coding to, e.g. ["Competitiveness Rating"]',
                  },
                  rowHeight: {
                    type: 'number',
                    description: 'Optional row height in pixels, e.g. 56 for thumbnails',
                  },
                },
              },
              hasDraftUpdates: {
                type: 'boolean',
                description: 'True if the user requested changes to the listing draft.',
              },
              draftUpdates: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  price: { type: 'number' },
                  shippingCost: { type: 'number' },
                  condition: {
                    type: 'string',
                    enum: ['NEW', 'LIKE_NEW', 'USED_EXCELLENT', 'USED_GOOD', 'FOR_PARTS_OR_NOT_WORKING'],
                  },
                  conditionDescription: { type: 'string' },
                  descriptionHtml: { type: 'string' },
                  aspects: {
                    type: 'object',
                    additionalProperties: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                  },
                },
              },
            },
            required: ['replyText', 'hasDraftUpdates'],
          },
        },
      }, this.queryModels);

      return JSON.parse(outputText);
    } catch (err: any) {
      console.warn('[Gemini] chatWithSeller error, falling back to basic reply:', err);
      const isQuotaError = /rate limit|quota|429|limit:\s*20\s*requests/i.test(err?.message || '');
      const replyText = isQuotaError
        ? `⚠️ **Gemini AI Daily Quota Exceeded**\n\nThe Gemini API key has reached its Google AI Studio Free Tier limit (20 requests/day for Flash models or 0 quota for Gemini 4 Argon).\n\n💡 **How to resolve:**\n• Switch your Gemini project to **Pay-As-You-Go** at https://ai.dev/rate-limit for high rate limits (2,000 RPM).\n• Or wait for the daily quota to reset (resets at midnight Pacific Time).`
        : `I received your message: "${userMessage}". Let me know if you would like to adjust the price, title, or publish!`;

      return {
        replyText,
        hasDraftUpdates: false,
        isInventoryInquiry: false,
        isSheetExportRequested: false,
      };
    }
  }
}
