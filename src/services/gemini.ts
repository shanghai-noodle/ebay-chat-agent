import { ListingDraft } from '../types/draft';

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
    shippingCost: {
      type: 'number',
      description: 'Shipping cost in USD. Default is 0 (Free shipping), unless the user explicitly requested a specific shipping fee.',
    },
  },
  required: ['title', 'categoryKeywords', 'condition', 'conditionDescription', 'aspects', 'descriptionHtml', 'suggestedPrice'],
};

export class GeminiService {
  private apiKey: string;
  private candidateModels = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash-preview'];

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async callInteractionsApi(payload: any): Promise<string> {
    let lastError: Error | undefined;

    for (const model of this.candidateModels) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions?key=${this.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, model }),
        });

        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as any;
          const msg = errData?.error?.message || res.statusText;
          lastError = new Error(`Gemini ${model} failed (${res.status}): ${msg}`);
          console.warn(`[Gemini] ${model} error: ${msg}. Attempting fallback if available.`);
          continue;
        }

        const data = (await res.json()) as any;
        const textStep = data.steps?.find((s: any) => s.type === 'model_output');
        const outputText = textStep?.content?.[0]?.text || data.output_text;

        if (!outputText) {
          lastError = new Error(`Gemini ${model} did not return any output text.`);
          continue;
        }

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

    // Pass up to 5 images to Gemini to provide rich context without exceeding payload limits
    const selectedImages = images.slice(0, 5);
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
}
