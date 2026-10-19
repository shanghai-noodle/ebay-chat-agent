import { Hono } from 'hono';
import { CloudflareBindings } from './env';
import { ListingDraft } from './types/draft';
import { DraftStore } from './services/draft-store';
import { GeminiService } from './services/gemini';
import { EbayEPSService } from './services/ebay/eps';
import { EbayTaxonomyService } from './services/ebay/taxonomy';
import { EbayTradingService, SellerInventorySummary } from './services/ebay/trading';
import { GoogleChatCards } from './services/google-chat/cards';
import { GoogleChatMediaService } from './services/google-chat/media';
import {
  GoogleSheetsService,
  GoogleSheetsApiDisabledError,
  GoogleSheetsDriveQuotaError,
} from './services/google-sheets';
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

// Internal Service-Binding Bridge for Bluestone Lab Storefront eBay Sync
app.post('/internal/ebay-xml', async (c) => {
  const { callName, xmlBody } = await c.req.json<{ callName: string; xmlBody: string }>();
  const userToken = c.env.EBAY_USER_TOKEN || '';
  const isOAuth = userToken.startsWith('v^1.');
  const credsXml = isOAuth
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${userToken}</eBayAuthToken></RequesterCredentials>`;

  const finalXml = xmlBody
    .replace(/<RequesterCredentials>[\s\S]*?<\/RequesterCredentials>/i, credsXml)
    .replace('<!--EBAY_CREDENTIALS-->', credsXml);

  const headers: Record<string, string> = {
    'Content-Type': 'text/xml; charset=utf-8',
    'X-EBAY-API-COMPATIBILITY-LEVEL': '967',
    'X-EBAY-API-CALL-NAME': callName,
    'X-EBAY-API-SITEID': '0',
  };
  if (c.env.EBAY_APP_ID) headers['X-EBAY-API-APP-NAME'] = c.env.EBAY_APP_ID;
  if (c.env.EBAY_DEV_ID) headers['X-EBAY-API-DEV-NAME'] = c.env.EBAY_DEV_ID;
  if (c.env.EBAY_CERT_ID) headers['X-EBAY-API-CERT-NAME'] = c.env.EBAY_CERT_ID;
  if (isOAuth) headers['X-EBAY-API-IAF-TOKEN'] = userToken;

  const epsUrl = c.env.EBAY_EPS_URL || 'https://api.ebay.com/ws/api.dll';
  const res = await fetch(epsUrl, {
    method: 'POST',
    headers,
    body: finalXml,
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
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
    const safePromise = promise.catch((err) => {
      console.error('[Background] Unhandled error in background task:', err);
    });
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(safePromise);
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

    if (actionMethod === 'create_sheet_report') {
      waitUntil(
        (async () => {
          try {
            const tradingService = new EbayTradingService({
              epsUrl: c.env.EBAY_EPS_URL,
              userToken: c.env.EBAY_USER_TOKEN,
              appId: c.env.EBAY_APP_ID,
              devId: c.env.EBAY_DEV_ID,
              certId: c.env.EBAY_CERT_ID,
            });

            const inventorySummary = await tradingService.getActiveSellerListings(false, c.env);
            if (!inventorySummary || inventorySummary.totalCount === 0) {
              await GoogleChatMediaService.postMessage(
                spaceId,
                {
                  ...(threadKey ? { thread: { name: threadKey } } : {}),
                  text: '⚠️ No active listings found in your eBay store to generate a report.',
                },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
              return;
            }

            if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
              throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
            }
            const kvSheetId = (await c.env.DRAFTS_KV?.get('report:master_sheet_id')) || undefined;
            let cmaData: any = null;
            try {
              const cachedCma = await c.env.DRAFTS_KV?.get('report:cma_market_research_v1');
              if (cachedCma) {
                cmaData = JSON.parse(cachedCma);
              }
            } catch (cmaErr) {
              console.warn('[CMA] Failed to read cached CMA data for button report:', cmaErr);
            }

            const sheetsService = new GoogleSheetsService(c.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            const report = await sheetsService.createInventorySpreadsheet(inventorySummary, {
              spreadsheetId: kvSheetId,
              userEmail: params.userEmail,
              clearExisting: true,
              cmaData,
            });

            if (report.spreadsheetId && c.env.DRAFTS_KV) {
              await c.env.DRAFTS_KV.put('report:master_sheet_id', report.spreadsheetId);
            }

            const sheetCard = GoogleChatCards.buildSheetCreatedCard(report).cardsV2[0];
            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                cardsV2: [sheetCard],
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          } catch (err: any) {
            console.error('[GoogleSheets] Error generating spreadsheet from button:', err);
            let errCard: any;
            if (err instanceof GoogleSheetsApiDisabledError) {
              errCard = GoogleChatCards.buildSheetApiDisabledCard(err.activationUrl).cardsV2[0];
            } else if (err instanceof GoogleSheetsDriveQuotaError) {
              errCard = GoogleChatCards.buildLinkSheetCard(err.serviceAccountEmail).cardsV2[0];
            } else {
              errCard = GoogleChatCards.buildErrorCard(
                `Failed to create Google Sheet: ${err.message || err}`
              ).cardsV2[0];
            }

            if (spaceId) {
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

      return c.json({
        renderActions: {
          action: {
            notification: {
              text: '📊 Generating your Google Sheet report...',
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
          try {
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

            // Automatically inspect EXIF while preserving 100% original photo quality & background
            console.log(`[ImageProcessor] Processing ${rawImages.length} photo(s) (preserving 100% original fidelity)...`);
            const validImages = rawImages.map((img) => {
              const processed = ImageProcessor.processPhoto(img.base64);
              return {
                base64: processed.base64,
                mimeType: processed.mimeType,
              };
            });

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
              const uploadBatchSize = 3;
              const epsResults: PromiseSettledResult<string>[] = [];
              for (let i = 0; i < validImages.length; i += uploadBatchSize) {
                const batch = validImages.slice(i, i + uploadBatchSize);
                const batchResults = await Promise.allSettled(
                  batch.map((img, idx) =>
                    eps.uploadPicture(img.base64, `Photo-${Date.now()}-${existingDraft.imageUrls.length + i + idx + 1}`)
                  )
                );
                epsResults.push(...batchResults);
              }

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

            // Brand new draft creation: run Gemini vision & EPS uploads in batches
            const gemini = new GeminiService(c.env.GEMINI_API_KEY);
            const taxonomy = new EbayTaxonomyService({
              apiBase: c.env.EBAY_API_BASE,
              appId: c.env.EBAY_APP_ID,
              certId: c.env.EBAY_CERT_ID,
            });

            console.log(`[Processing] Analyzing ${validImages.length} photo(s) with Gemini Vision & uploading to eBay EPS in batches...`);

            // Upload to EPS in batches of 3 to avoid overwhelming connection and memory limits
            const uploadBatchSize = 3;
            const uploadEpsInBatches = async () => {
              const allResults: PromiseSettledResult<string>[] = [];
              for (let i = 0; i < validImages.length; i += uploadBatchSize) {
                const batch = validImages.slice(i, i + uploadBatchSize);
                const batchResults = await Promise.allSettled(
                  batch.map((img, idx) =>
                    eps.uploadPicture(img.base64, `Photo-${Date.now()}-${i + idx + 1}`)
                  )
                );
                allResults.push(...batchResults);
              }
              return allResults;
            };

            const [analysis, epsResults] = await Promise.all([
              gemini.analyzeItemImages(validImages, messageText),
              uploadEpsInBatches(),
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
            console.error('[Processing] Fatal photo processing error:', err);
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

        const tradingService = new EbayTradingService({
          epsUrl: c.env.EBAY_EPS_URL,
          userToken: c.env.EBAY_USER_TOKEN,
          appId: c.env.EBAY_APP_ID,
          devId: c.env.EBAY_DEV_ID,
          certId: c.env.EBAY_CERT_ID,
        });

        // Load active inventory (fast <5ms KV lookup or live eBay Trading API query)
        const isForceRefresh = /\b(refresh|sync|force|reload)\b/i.test(messageText);
        let inventorySummary: SellerInventorySummary | null = null;
        try {
          inventorySummary = await tradingService.getActiveSellerListings(isForceRefresh, c.env);
        } catch (invErr) {
          console.warn('[Inventory] Failed to fetch seller inventory:', invErr);
        }

        const isInventoryQuery =
          /\b(inventory|listings?|listed|portfolio|active\s+items?|check\s+items?|analyze|audit|how\s+many\s+items|what\s+do\s+i\s+have|catalog)\b/i.test(
            messageText
          ) ||
          /\b(237\d{9}|336\d{9}|334\d{9}|234\d{9})\b/.test(messageText);

        // Check if user provided a Google Sheet URL or ID
        const sheetMatch =
          messageText.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/i) ||
          messageText.match(/sheet(?:\s*id)?[:\s]+([a-zA-Z0-9-_]{25,})/i) ||
          messageText.match(/\b(1[a-zA-Z0-9-_]{35,45})\b/i);

        const targetSheetId = sheetMatch ? sheetMatch[1] : undefined;
        if (targetSheetId && c.env.DRAFTS_KV) {
          await c.env.DRAFTS_KV.put('report:master_sheet_id', targetSheetId);
        }

        const handleSheetReportRequest = async (explicitSheetId?: string) => {
          if (!inventorySummary || inventorySummary.totalCount === 0) {
            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                text: '⚠️ No active listings found in your eBay store to generate a report.',
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
            return;
          }

          try {
            if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
              throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON in environment');
            }
            const kvSheetId = (await c.env.DRAFTS_KV?.get('report:master_sheet_id')) || undefined;
            const effectiveSheetId = explicitSheetId || targetSheetId || kvSheetId;

            let cmaData: any = null;
            try {
              const cachedCma = await c.env.DRAFTS_KV?.get('report:cma_market_research_v1');
              if (cachedCma) {
                cmaData = JSON.parse(cachedCma);
              }
            } catch (cmaErr) {
              console.warn('[CMA] Failed to read cached CMA data:', cmaErr);
            }

            const isClearRequested = /\b(clear|wipe|overwrite|fresh|clean)\b/i.test(messageText);

            const sheetsService = new GoogleSheetsService(c.env.GOOGLE_SERVICE_ACCOUNT_JSON);
            const report = await sheetsService.createInventorySpreadsheet(inventorySummary, {
              spreadsheetId: effectiveSheetId,
              userEmail: senderEmail,
              clearExisting: isClearRequested || Boolean(effectiveSheetId),
              cmaData,
            });

            if (report.spreadsheetId && c.env.DRAFTS_KV) {
              await c.env.DRAFTS_KV.put('report:master_sheet_id', report.spreadsheetId);
            }

            const sheetCard = GoogleChatCards.buildSheetCreatedCard(report).cardsV2[0];
            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                cardsV2: [sheetCard],
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          } catch (err: any) {
            console.error('[GoogleSheets] Conversational sheet generation error:', err);
            let errCard: any;
            if (err instanceof GoogleSheetsApiDisabledError) {
              errCard = GoogleChatCards.buildSheetApiDisabledCard(err.activationUrl).cardsV2[0];
            } else if (err instanceof GoogleSheetsDriveQuotaError) {
              errCard = GoogleChatCards.buildLinkSheetCard(err.serviceAccountEmail).cardsV2[0];
            } else {
              errCard = GoogleChatCards.buildErrorCard(
                `Failed to generate Google Sheet: ${err.message || err}`
              ).cardsV2[0];
            }

            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                cardsV2: [errCard],
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          }
        };

        const isPureLink =
          targetSheetId &&
          (messageText.trim().startsWith('http') ||
            messageText.trim().length <= 50 ||
            /^(link|set|use|here is|here's)?\s*(my\s*)?(google\s*)?sheet/i.test(messageText.trim()));

        if (isPureLink) {
          await GoogleChatMediaService.postMessage(
            spaceId,
            {
              ...(threadKey ? { thread: { name: threadKey } } : {}),
              text: '🔗 Linking your Google Sheet and updating your market research and inventory report...',
            },
            c.env.GOOGLE_SERVICE_ACCOUNT_JSON
          );
          await handleSheetReportRequest(targetSheetId);
          return;
        }

        if (!existingDraft) {
          try {
            const gemini = new GeminiService(c.env.GEMINI_API_KEY);
            const chatResult = await gemini.chatWithSeller(messageText, null, inventorySummary);

            // 1. Post Gemini's conversational reply message
            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                text:
                  chatResult.replyText ||
                  '👋 Hi! Upload a photo of any item you want to sell, and I will draft a listing, estimate pricing, and publish it to eBay for you!',
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );

            // 2. If user requested a Google Sheet report, generate and post it
            const isSheetRequested =
              chatResult.isSheetExportRequested ||
              Boolean(targetSheetId) ||
              /\b(google\s+sheets?|sheets?|spreadsheets?|excel|csv|export\s+to\s+sheets?|reporting|report|market\s+research|comps)\b/i.test(
                messageText
              );

            if (isSheetRequested) {
              await handleSheetReportRequest(targetSheetId);
            } else if (
              (isInventoryQuery || chatResult.isInventoryInquiry) &&
              inventorySummary &&
              inventorySummary.totalCount > 0
            ) {
              const invCard = GoogleChatCards.buildInventorySummaryCard(inventorySummary).cardsV2[0];
              await GoogleChatMediaService.postMessage(
                spaceId,
                {
                  ...(threadKey ? { thread: { name: threadKey } } : {}),
                  cardsV2: [invCard],
                },
                c.env.GOOGLE_SERVICE_ACCOUNT_JSON
              );
            }
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
          const chatResult = await gemini.chatWithSeller(messageText, existingDraft, inventorySummary);

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

          // If the user requested a Google Sheet report, generate and post it
          const isSheetRequested =
            chatResult.isSheetExportRequested ||
            /\b(google\s+sheets?|sheets?|spreadsheets?|excel|csv|export\s+to\s+sheets?|reporting)\b/i.test(messageText);

          if (isSheetRequested) {
            await handleSheetReportRequest();
          } else if (
            (isInventoryQuery || chatResult.isInventoryInquiry) &&
            inventorySummary &&
            inventorySummary.totalCount > 0
          ) {
            const invCard = GoogleChatCards.buildInventorySummaryCard(inventorySummary).cardsV2[0];
            await GoogleChatMediaService.postMessage(
              spaceId,
              {
                ...(threadKey ? { thread: { name: threadKey } } : {}),
                cardsV2: [invCard],
              },
              c.env.GOOGLE_SERVICE_ACCOUNT_JSON
            );
          }

          // 2. Save draft and update Card v2 preview (only if draft is still in draft state, not published)
          if (existingDraft.status !== 'PUBLISHED') {
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
          }
        } catch (geminiErr: any) {
          console.error('[Chat] Conversational error:', geminiErr);
          await GoogleChatMediaService.postMessage(
            spaceId,
            {
              ...(threadKey ? { thread: { name: threadKey } } : {}),
              text: `⚠️ I encountered an issue processing your request: ${geminiErr.message || geminiErr}. Please try again!`,
            },
            c.env.GOOGLE_SERVICE_ACCOUNT_JSON
          );
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
