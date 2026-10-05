import { Hono } from 'hono';
import { CloudflareBindings } from './env';
import { ListingDraft } from './types/draft';
import { DraftStore } from './services/draft-store';
import { GeminiService } from './services/gemini';
import { EbayEPSService } from './services/ebay/eps';
import { EbayTaxonomyService } from './services/ebay/taxonomy';
import { EbayTradingService } from './services/ebay/trading';
import { GoogleChatCards } from './services/google-chat/cards';
import { GoogleChatMediaService } from './services/google-chat/media';
import { AVATAR_BASE64 } from './assets/avatar-data';
import { ImageProcessor } from './services/image-processor';

const app = new Hono<{ Bindings: CloudflareBindings }>();

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'ebay-chat-agent',
    env: c.env.EBAY_ENV || 'sandbox',
    timestamp: new Date().toISOString(),
  });
});

// Agent Avatar Logo Endpoint
app.get('/avatar.png', (c) => {
  const binary = Uint8Array.from(atob(AVATAR_BASE64), char => char.charCodeAt(0));
  return new Response(binary, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  });
});

// 1-Click Browser Publish Endpoint (Triggered when user clicks "🚀 Publish to eBay" button)
app.get('/publish', async (c) => {
  const draftId = c.req.query('draftId');
  const spaceId = c.req.query('spaceId') || '';
  const threadKey = c.req.query('threadKey') || '';

  const draftStore = new DraftStore(c.env.DRAFTS_KV);
  let draft = draftId ? await draftStore.getDraftById(draftId) : null;
  if (!draft && spaceId && threadKey) {
    draft = await draftStore.getDraft(spaceId, threadKey);
  }

  if (!draft) {
    return c.html(`<!DOCTYPE html><html><body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:50px;">
      <h2>⚠️ Draft Not Found or Expired</h2>
      <p>Please return to Google Chat and upload the photo again.</p>
    </body></html>`);
  }

  if (draft.status === 'PUBLISHED' && draft.listingUrl) {
    return c.redirect(draft.listingUrl);
  }

  try {
    const tradingService = new EbayTradingService({
      epsUrl: c.env.EBAY_EPS_URL,
      userToken: c.env.EBAY_USER_TOKEN,
      appId: c.env.EBAY_APP_ID,
      devId: c.env.EBAY_DEV_ID,
      certId: c.env.EBAY_CERT_ID,
    });

    const publishResult = await tradingService.addItem(draft);

    draft.status = 'PUBLISHED';
    draft.listingId = publishResult.listingId;
    draft.listingUrl = publishResult.listingUrl;
    await draftStore.saveDraft(draft);

    // Patch original card in Google Chat with the live confirmation!
    if (draft.messageName && c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const successCard = GoogleChatCards.buildPublishedSuccessCard(
        draft,
        publishResult.listingUrl,
        publishResult.listingId
      ).cardsV2[0];

      if (c.executionCtx?.waitUntil) {
        c.executionCtx.waitUntil(
          GoogleChatMediaService.patchMessage(
            draft.messageName,
            { cardsV2: [successCard] },
            c.env.GOOGLE_SERVICE_ACCOUNT_JSON
          )
        );
      } else {
        await GoogleChatMediaService.patchMessage(
          draft.messageName,
          { cardsV2: [successCard] },
          c.env.GOOGLE_SERVICE_ACCOUNT_JSON
        );
      }
    }

    return c.redirect(publishResult.listingUrl);
  } catch (err: any) {
    console.error('[WebPublish] Error:', err);
    return c.html(`<!DOCTYPE html><html><body style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:50px;">
      <h2>❌ Publishing Error</h2>
      <p style="color:#d93025;font-weight:bold;">${err.message || err}</p>
      <p>Please return to Google Chat and try again.</p>
    </body></html>`);
  }
});

// Google Chat Webhook Handler
app.post('/', async (c) => {
  const event = (await c.req.json()) as any;
  console.log('Incoming event:', JSON.stringify(event));

  const draftStore = new DraftStore(c.env.DRAFTS_KV);

  // Helper to run background tasks safely via Cloudflare Workers ExecutionContext
  const waitUntil = (promise: Promise<any>) => {
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(promise);
    } else {
      promise.catch((err) => console.error('[Background] Unhandled error:', err));
    }
  };

  // Extract payloads from Google Chat API
  const chatObj = event.chat || {};
  const commonEventObj = event.commonEventObject || {};
  const messagePayload = chatObj.messagePayload || (event.type === 'MESSAGE' ? event : null);
  const buttonPayload = chatObj.buttonClickedPayload || (event.type === 'CARD_CLICKED' ? event.action : null);
  const addedPayload = chatObj.addedToSpacePayload || (event.type === 'ADDED_TO_SPACE' ? event : null);

  const actionMethod =
    commonEventObj.invokedFunction ||
    buttonPayload?.actionMethodName ||
    buttonPayload?.action?.actionMethodName ||
    buttonPayload?.action?.function ||
    buttonPayload?.invokedFunction ||
    event.action?.actionMethodName ||
    event.action?.function;

  // 1. Bot added to space
  if (addedPayload) {
    const spaceId = addedPayload.space?.name || event.space?.name;
    const threadKey = addedPayload.message?.thread?.name;
    const welcomeText =
      '👋 Hi! I am your eBay Listing Assistant. Send me a photo of any item you want to sell, and I will draft a listing, estimate pricing, and publish it to eBay for you!';

    if (spaceId && c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      waitUntil(
        GoogleChatMediaService.postMessage(
          spaceId,
          {
            text: welcomeText,
            ...(threadKey ? { thread: { name: threadKey } } : {}),
          },
          c.env.GOOGLE_SERVICE_ACCOUNT_JSON
        )
      );
    }
    return c.json({});
  }

  // 2. Interactive Card button clicked (Publish or Discard)
  if (actionMethod) {
    let params: Record<string, string> = {};
    if (commonEventObj.parameters && typeof commonEventObj.parameters === 'object') {
      params = { ...params, ...commonEventObj.parameters };
    }

    const rawParams =
      buttonPayload?.parameters ||
      buttonPayload?.action?.parameters ||
      buttonPayload?.actionParameters ||
      event.action?.parameters ||
      [];

    if (Array.isArray(rawParams)) {
      for (const p of rawParams) {
        if (p.key && p.value) params[p.key] = p.value;
        if (p.name && p.value) params[p.name] = p.value;
      }
    } else if (typeof rawParams === 'object' && rawParams !== null) {
      params = { ...params, ...rawParams };
    }

    const spaceId =
      params.spaceId ||
      buttonPayload?.space?.name ||
      chatObj.space?.name ||
      event.space?.name ||
      '';

    const threadKey =
      params.threadKey ||
      buttonPayload?.message?.thread?.name ||
      chatObj.message?.thread?.name ||
      chatObj.messagePayload?.message?.thread?.name ||
      event.message?.thread?.name ||
      '';

    const clickedMessageName =
      buttonPayload?.message?.name ||
      chatObj.message?.name ||
      event.message?.name ||
      '';

    const draftId = params.draftId;

    if (actionMethod === 'publish_listing') {
      waitUntil(
        (async () => {
          let draft = draftId ? await draftStore.getDraftById(draftId) : null;
          if (!draft && spaceId && threadKey) {
            draft = await draftStore.getDraft(spaceId, threadKey);
          }

          const targetMessageName = draft?.messageName || clickedMessageName;

          if (!draft) {
            const errCard = GoogleChatCards.buildErrorCard(
              'Listing draft not found or expired. Please upload the photo again.'
            ).cardsV2[0];

            if (targetMessageName) {
              await GoogleChatMediaService.patchMessage(
                targetMessageName,
                { cardsV2: [errCard] },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
            } else if (spaceId) {
              await GoogleChatMediaService.postMessage(
                spaceId,
                {
                  ...(threadKey ? { thread: { name: threadKey } } : {}),
                  cardsV2: [errCard],
                },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
            }
            return;
          }

          if (draft.status === 'PUBLISHED' && draft.listingUrl && draft.listingId) {
            const successCard = GoogleChatCards.buildPublishedSuccessCard(
              draft,
              draft.listingUrl,
              draft.listingId
            ).cardsV2[0];
            if (targetMessageName) {
              await GoogleChatMediaService.patchMessage(
                targetMessageName,
                { cardsV2: [successCard] },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
            }
            return;
          }

          try {
            const tradingService = new EbayTradingService({
              epsUrl: c.env.EBAY_EPS_URL,
              userToken: c.env.EBAY_USER_TOKEN,
              appId: c.env.EBAY_APP_ID,
              devId: c.env.EBAY_DEV_ID,
              certId: c.env.EBAY_CERT_ID,
            });

            const publishResult = await tradingService.addItem(draft);

            draft.status = 'PUBLISHED';
            draft.listingId = publishResult.listingId;
            draft.listingUrl = publishResult.listingUrl;

            await draftStore.saveDraft(draft);

            const successCard = GoogleChatCards.buildPublishedSuccessCard(
              draft,
              publishResult.listingUrl,
              publishResult.listingId
            ).cardsV2[0];

            let patched = false;
            if (targetMessageName) {
              const patchRes = await GoogleChatMediaService.patchMessage(
                targetMessageName,
                { cardsV2: [successCard] },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
              if (patchRes) patched = true;
            }

            if (!patched && spaceId) {
              await GoogleChatMediaService.postMessage(
                spaceId,
                {
                  ...(threadKey ? { thread: { name: threadKey } } : {}),
                  cardsV2: [successCard],
                },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
            }
          } catch (err: any) {
            console.error('[Publish] Error publishing to eBay:', err);
            const errCard = GoogleChatCards.buildErrorCard(
              `Failed to publish listing to eBay: ${err.message || err}`
            ).cardsV2[0];

            if (targetMessageName) {
              await GoogleChatMediaService.patchMessage(
                targetMessageName,
                { cardsV2: [errCard] },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
            } else if (spaceId) {
              await GoogleChatMediaService.postMessage(
                spaceId,
                {
                  ...(threadKey ? { thread: { name: threadKey } } : {}),
                  cardsV2: [errCard],
                },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
            }
          }
        })()
      );

      // Return valid Google Workspace Add-on renderActions notification
      return c.json({
        renderActions: {
          action: {
            notification: {
              text: '🚀 Publishing listing to eBay...',
            },
          },
        },
      });
    }

    if (actionMethod === 'discard_draft') {
      waitUntil(
        (async () => {
          let draft = draftId ? await draftStore.getDraftById(draftId) : null;
          if (spaceId && threadKey) {
            await draftStore.deleteDraft(spaceId, threadKey, draftId);
          }

          const targetMessageName = draft?.messageName || clickedMessageName;
          const discardCard = GoogleChatCards.buildErrorCard(
            '🗑️ Listing draft discarded. Upload another photo whenever you are ready!'
          ).cardsV2[0];

          if (targetMessageName) {
            await GoogleChatMediaService.patchMessage(
              targetMessageName,
              { cardsV2: [discardCard] },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          } else if (spaceId) {
            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                cardsV2: [discardCard],
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          }
        })()
      );

      return c.json({
        renderActions: {
          action: {
            notification: {
              text: '🗑️ Listing draft discarded.',
            },
          },
        },
      });
    }
  }

  // 3. User sent a message (with photo or conversational text)
  if (messagePayload) {
    const msg = messagePayload.message || {};
    const spaceId =
      messagePayload.space?.name ||
      chatObj.space?.name ||
      event.space?.name ||
      '';

    const threadKey =
      msg.thread?.name ||
      msg.thread?.threadKey ||
      messagePayload?.message?.thread?.name ||
      chatObj.message?.thread?.name ||
      event.message?.thread?.name ||
      '';

    const messageText = (msg.text || msg.argumentText || '').trim();
    const attachments = msg.attachment || [];
    const senderEmail = chatObj.user?.email || event.user?.email;

    // Case A: User uploaded one or more photos
    if (attachments.length > 0) {
      waitUntil(
        (async () => {
          const imageAttachments = attachments.filter((att: any) => {
            const mime = (att.contentType || '').toLowerCase();
            return !mime || mime.startsWith('image/') || mime === 'application/octet-stream';
          });

          const candidateAttachments = (imageAttachments.length > 0 ? imageAttachments : attachments).slice(0, 16);
          console.log(`[Attachments] Processing ${attachments.length} attachments (candidate images: ${candidateAttachments.length})`);

          // Download all attachments in parallel
          const downloadResults = await Promise.all(
            candidateAttachments.map(async (att: any, idx: number) => {
              try {
                const downloaded = await GoogleChatMediaService.downloadAttachmentAsBase64(
                  att,
                  c.env.GOOGLE_SERVICE_ACCOUNT_JSON
                );
                if (downloaded.base64) {
                  return {
                    index: idx,
                    base64: downloaded.base64,
                    mimeType: downloaded.mimeType,
                  };
                }
              } catch (err: any) {
                console.warn(`[Download] Attachment ${idx} download failed:`, err);
              }
              return null;
            })
          );

          const rawImages = downloadResults.filter((img): img is NonNullable<typeof img> => img !== null);

          if (rawImages.length === 0) {
            const hasDrive = attachments.some((a: any) => a.driveDataRef?.driveFileId);
            if (hasDrive) {
              await GoogleChatMediaService.postMessage(
                spaceId,
                {
                  ...(threadKey ? { thread: { name: threadKey } } : {}),
                  text: '⚠️ Please upload images directly from your computer or phone (click the paperclip > **Upload from computer** or drag & drop), rather than selecting from Google Drive.',
                },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
              return;
            }

            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                text: '⚠️ Could not download the uploaded photo(s). Please try uploading image files directly.',
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
            return;
          }

          // Automatically correct EXIF orientation (upright) while preserving 100% original photo quality & background
          console.log(`[ImageProcessor] Processing ${rawImages.length} photo(s) (orientation check & correction)...`);
          const validImages = rawImages.map((img) => {
            const processed = ImageProcessor.processPhoto(img.base64);
            return {
              base64: processed.base64,
              mimeType: processed.mimeType,
            };
          });

          try {
            const eps = new EbayEPSService({
              epsUrl: c.env.EBAY_EPS_URL,
              appId: c.env.EBAY_APP_ID,
              devId: c.env.EBAY_DEV_ID,
              certId: c.env.EBAY_CERT_ID,
              userToken: c.env.EBAY_USER_TOKEN,
            });

            // Check if active draft already exists in this space & thread
            const existingDraft = await draftStore.getDraft(spaceId, threadKey);
            const isAddingToExisting = existingDraft && existingDraft.status === 'READY_TO_PUBLISH';

            if (isAddingToExisting) {
              console.log(`[Upload] Adding ${validImages.length} photo(s) to existing draft ${existingDraft.id}`);
              const epsResults = await Promise.allSettled(
                validImages.map((img, i) =>
                  eps.uploadPicture(img.base64, `Photo-${Date.now()}-${existingDraft.imageUrls.length + i + 1}`)
                )
              );

              const addedUrls = epsResults
                .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
                .map((r) => r.value);

              if (addedUrls.length === 0) {
                throw new Error('Failed to upload new photo(s) to eBay Picture Services.');
              }

              const combinedUrls = Array.from(new Set([...existingDraft.imageUrls, ...addedUrls])).slice(0, 16);
              existingDraft.imageUrls = combinedUrls;
              existingDraft.updatedAt = Date.now();
              await draftStore.saveDraft(existingDraft);

              const previewCard = GoogleChatCards.buildListingPreviewCard(existingDraft).cardsV2[0];
              await GoogleChatMediaService.postMessage(
                spaceId,
                {
                  ...(threadKey ? { thread: { name: threadKey } } : {}),
                  text: `📸 Added ${addedUrls.length} new photo(s)! Total gallery photos: ${combinedUrls.length}/16 ready for eBay.`,
                  cardsV2: [previewCard],
                },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
              return;
            }

            // Brand new draft creation: run Gemini vision & EPS uploads in parallel
            const gemini = new GeminiService(c.env.GEMINI_API_KEY);
            const taxonomy = new EbayTaxonomyService({
              apiBase: c.env.EBAY_API_BASE,
              appId: c.env.EBAY_APP_ID,
              certId: c.env.EBAY_CERT_ID,
            });

            console.log(`[Processing] Analyzing ${validImages.length} photo(s) with Gemini Vision & uploading to eBay EPS...`);
            const [analysis, epsResults] = await Promise.all([
              gemini.analyzeItemImages(validImages, messageText),
              Promise.allSettled(
                validImages.map((img, i) =>
                  eps.uploadPicture(img.base64, `Photo-${Date.now()}-${i + 1}`)
                )
              ),
            ]);

            const newEpsUrls = epsResults
              .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
              .map((r) => r.value);

            if (newEpsUrls.length === 0) {
              const firstRejected = epsResults.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
              throw new Error(`Failed to upload photos to eBay EPS: ${firstRejected?.reason?.message || 'Unknown EPS error'}`);
            }

            console.log(`[Processing] Uploaded ${newEpsUrls.length}/${validImages.length} images to eBay EPS.`);

            // Resolve eBay leaf category
            const categoryMatch = await taxonomy.getCategorySuggestion(
              analysis.categoryKeywords || analysis.title
            );

            let initialShipping = typeof analysis.shippingCost === 'number' && !isNaN(analysis.shippingCost) && analysis.shippingCost >= 0
              ? analysis.shippingCost
              : 0;

            if (/\bfree\s+shipping\b/i.test(messageText)) {
              initialShipping = 0;
            } else {
              const directShipMatch = messageText.match(/shipping\s*(?:cost|fee|to|for|is|of|\$)?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
              if (directShipMatch) {
                const parsed = parseFloat(directShipMatch[1]);
                if (!isNaN(parsed) && parsed >= 0) initialShipping = parsed;
              }
            }

            const draft: ListingDraft = {
              id: `draft_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
              spaceId,
              threadKey,
              userEmail: senderEmail,
              status: 'READY_TO_PUBLISH',
              title: analysis.title,
              descriptionHtml: analysis.descriptionHtml,
              condition: analysis.condition,
              conditionDescription: analysis.conditionDescription,
              aspects: analysis.aspects,
              categoryId: categoryMatch?.categoryId || '15709',
              categoryName: categoryMatch?.categoryName || 'General Merchandise',
              price: analysis.suggestedPrice.recommended,
              currency: 'USD',
              quantity: 1,
              shippingCost: initialShipping,
              marketIntelligence: analysis.marketIntelligence,
              imageUrls: newEpsUrls.slice(0, 16),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };

            const previewCard = GoogleChatCards.buildListingPreviewCard(draft).cardsV2[0];

            const postRes = await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                cardsV2: [previewCard],
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );

            if (postRes?.name) {
              draft.messageName = postRes.name;
            }
            await draftStore.saveDraft(draft);
          } catch (err: any) {
            console.error('[Processing] Image processing error:', err);
            const errCard = GoogleChatCards.buildErrorCard(
              `Error processing photo: ${err.message || err}`
            ).cardsV2[0];

            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                cardsV2: [errCard],
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          }
        })()
      );

      // Return HTTP 200 immediately to prevent Google Chat webhook timeout
      return c.json({});
    }

    // Case B: Conversational text (refinements or commands)
    waitUntil(
      (async () => {
        const existingDraft = await draftStore.getDraft(spaceId, threadKey);

        if (!existingDraft) {
          try {
            const gemini = new GeminiService(c.env.GEMINI_API_KEY);
            const chatResult = await gemini.chatWithSeller(messageText, null);
            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                text: chatResult.replyText || '👋 Hi! Upload a photo of any item you want to sell, and I will draft a listing, estimate pricing, and publish it to eBay for you!',
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          } catch (err: any) {
            console.error('[Chat] General Q&A error:', err);
            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                text: '📸 Please upload a photo of the item you want to sell first, and I will generate your listing draft!',
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          }
          return;
        }

        // If user typed "publish", "list it", etc.
        if (/\b(publish|list\s+it|post\s+it|confirm)\b/i.test(messageText)) {
          try {
            const tradingService = new EbayTradingService({
              epsUrl: c.env.EBAY_EPS_URL,
              userToken: c.env.EBAY_USER_TOKEN,
              appId: c.env.EBAY_APP_ID,
              devId: c.env.EBAY_DEV_ID,
              certId: c.env.EBAY_CERT_ID,
            });

            const publishResult = await tradingService.addItem(existingDraft);

            existingDraft.status = 'PUBLISHED';
            existingDraft.listingId = publishResult.listingId;
            existingDraft.listingUrl = publishResult.listingUrl;

            await draftStore.saveDraft(existingDraft);

            const successCard = GoogleChatCards.buildPublishedSuccessCard(
              existingDraft,
              publishResult.listingUrl,
              publishResult.listingId
            ).cardsV2[0];

            let patched = false;
            if (existingDraft.messageName) {
              const patchRes = await GoogleChatMediaService.patchMessage(
                existingDraft.messageName,
                { cardsV2: [successCard] },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
              if (patchRes) patched = true;
            }

            if (!patched && spaceId) {
              await GoogleChatMediaService.postMessage(
                spaceId,
                {
                  ...(threadKey ? { thread: { name: threadKey } } : {}),
                  cardsV2: [successCard],
                },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
            }
          } catch (err: any) {
            console.error('[Publish] Conversational publish error:', err);
            const errCard = GoogleChatCards.buildErrorCard(
              `Failed to publish listing to eBay: ${err.message || err}`
            ).cardsV2[0];

            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                cardsV2: [errCard],
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          }
          return;
        }

        // Fast-path: Direct price extraction if user specifies a number or dollar amount
        const directPriceMatch =
          messageText.match(/(?:price|for|to|\$)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i) ||
          messageText.match(/^\s*\$?(\d+(?:\.\d{1,2})?)\s*$/);

        if (directPriceMatch) {
          const newPrice = parseFloat(directPriceMatch[1]);
          if (!isNaN(newPrice) && newPrice > 0) {
            existingDraft.price = newPrice;
          }
        }

        // Fast-path: Direct shipping cost extraction (e.g. "free shipping", "shipping $5", "shipping 4.99")
        if (/\bfree\s+shipping\b/i.test(messageText)) {
          existingDraft.shippingCost = 0;
        } else {
          const directShippingMatch = messageText.match(/shipping\s*(?:cost|fee|to|for|is|of|\$)?\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
          if (directShippingMatch) {
            const newShipping = parseFloat(directShippingMatch[1]);
            if (!isNaN(newShipping) && newShipping >= 0) {
              existingDraft.shippingCost = newShipping;
            }
          }
        }

        // Multi-turn conversational relay to Gemini for Q&A and intelligent draft refinements
        try {
          const gemini = new GeminiService(c.env.GEMINI_API_KEY);
          const chatResult = await gemini.chatWithSeller(messageText, existingDraft);

          if (chatResult.hasDraftUpdates && chatResult.draftUpdates) {
            const updates = chatResult.draftUpdates;
            if (updates.title) {
              let cleanTitle = updates.title.replace(/[\r\n]+/g, ' ').trim();
              if (
                cleanTitle.includes('"price":') ||
                cleanTitle.includes('"aspects":') ||
                cleanTitle.includes('{') ||
                cleanTitle.includes('}')
              ) {
                cleanTitle = cleanTitle.split(/["”]\s*,\s*"/)[0].replace(/["”{}]/g, '').trim();
              }
              if (cleanTitle.length > 0) {
                existingDraft.title = cleanTitle.slice(0, 80);
              }
            }

            if (typeof updates.price === 'number' && !isNaN(updates.price) && updates.price > 0) {
              existingDraft.price = updates.price;
            }
            if (typeof updates.shippingCost === 'number' && !isNaN(updates.shippingCost) && updates.shippingCost >= 0) {
              existingDraft.shippingCost = updates.shippingCost;
            }
            if (updates.condition) existingDraft.condition = updates.condition;
            if (updates.conditionDescription)
              existingDraft.conditionDescription = updates.conditionDescription;
            if (updates.descriptionHtml)
              existingDraft.descriptionHtml = updates.descriptionHtml;
            if (updates.aspects && typeof updates.aspects === 'object') {
              for (const [k, v] of Object.entries(updates.aspects)) {
                if (Array.isArray(v)) {
                  existingDraft.aspects[k] = v;
                } else if (typeof v === 'string') {
                  existingDraft.aspects[k] = [v];
                }
              }
            }
          }

          // 1. Post Gemini's conversational reply message to answer the user's question
          if (chatResult.replyText) {
            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                text: chatResult.replyText,
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          }

          // 2. Save draft and update Card v2 preview
          existingDraft.updatedAt = Date.now();
          await draftStore.saveDraft(existingDraft);

          const previewCard = GoogleChatCards.buildListingPreviewCard(existingDraft).cardsV2[0];

          let patched = false;
          if (existingDraft.messageName) {
            const patchRes = await GoogleChatMediaService.patchMessage(
              existingDraft.messageName,
              { cardsV2: [previewCard] },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
            if (patchRes) patched = true;
          }

          if (!patched && spaceId) {
            const postRes = await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                cardsV2: [previewCard],
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
            if (postRes?.name) {
              existingDraft.messageName = postRes.name;
              await draftStore.saveDraft(existingDraft);
            }
          }
        } catch (geminiErr: any) {
          console.error('[Chat] Conversational error:', geminiErr);
        }
      })()
    );

    return c.json({});
  }

  // 4. Default: App Home tab opened
  return c.json({
    header: {
      title: '🏷️ eBay Listing Agent',
      subtitle: `Environment: ${c.env.EBAY_ENV || 'sandbox'}`,
      imageUrl: 'https://pages.ebay.com/favicon.ico',
      imageType: 'SQUARE',
    },
    sections: [
      {
        header: 'How to List Items',
        widgets: [
          {
            textParagraph: {
              text: '1. Switch to the <b>Chat</b> tab.<br>2. Upload a photo of the item you want to sell.<br>3. Review the AI-generated title, condition, and pricing.<br>4. Tap <b>🚀 Publish to eBay</b>!',
            },
          },
        ],
      },
    ],
  });
});

export default app;
