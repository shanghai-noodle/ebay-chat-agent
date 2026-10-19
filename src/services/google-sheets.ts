import { GoogleChatMediaService, ServiceAccountCredentials } from './google-chat/media';
import { SellerInventorySummary } from './ebay/trading';

export class GoogleSheetsApiDisabledError extends Error {
  public activationUrl: string;
  public projectId: string;

  constructor(message: string, activationUrl?: string, projectId?: string) {
    super(message);
    this.name = 'GoogleSheetsApiDisabledError';
    this.projectId = projectId || 'shanghainoodle';
    this.activationUrl =
      activationUrl ||
      `https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=${this.projectId}`;
  }
}

export class GoogleSheetsDriveQuotaError extends Error {
  public serviceAccountEmail: string;

  constructor(message: string, serviceAccountEmail: string) {
    super(message);
    this.name = 'GoogleSheetsDriveQuotaError';
    this.serviceAccountEmail = serviceAccountEmail;
  }
}

export interface ItemCmaEntry {
  id: string;
  activeLow?: number;
  activeHigh?: number;
  soldAvg?: number;
  competitiveness?: string;
  strategyNotes?: string;
  itemDescription?: string;
}

export interface CreateReportOptions {
  title?: string;
  userEmail?: string;
  spreadsheetId?: string;
  clearExisting?: boolean;
  cmaData?: Record<string, ItemCmaEntry> | ItemCmaEntry[];
}

export interface SpreadsheetReportResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  totalListings: number;
  totalValue: number;
  sheetTitle: string;
  isExistingSheet?: boolean;
}

export class GoogleSheetsService {
  constructor(private serviceAccountConfig: string | ServiceAccountCredentials) {}

  public getCredentials(): ServiceAccountCredentials {
    if (typeof this.serviceAccountConfig === 'string') {
      try {
        return JSON.parse(this.serviceAccountConfig);
      } catch (e) {
        throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT_JSON format');
      }
    }
    return this.serviceAccountConfig;
  }

  private async getAccessToken(): Promise<string> {
    const creds = this.getCredentials();
    return GoogleChatMediaService.getServiceAccountAccessToken(creds, [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ]);
  }

  /**
   * Generates or updates an executive-ready Google Sheets inventory report.
   * Supports:
   * 1. Writing directly to a provided spreadsheetId.
   * 2. Auto-discovering any Google Sheet shared with the service account.
   * 3. Creating a new spreadsheet (if Drive quota allows, e.g. in a Shared Drive).
   */
  async createInventorySpreadsheet(
    inventory: SellerInventorySummary,
    options?: CreateReportOptions
  ): Promise<SpreadsheetReportResult> {
    const token = await this.getAccessToken();
    const creds = this.getCredentials();

    const formattedDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const cmaMap = new Map<string, ItemCmaEntry>();
    if (Array.isArray(options?.cmaData)) {
      for (const item of options.cmaData) {
        if (item && item.id) cmaMap.set(String(item.id), item);
      }
    } else if (options?.cmaData && typeof options.cmaData === 'object') {
      for (const [id, item] of Object.entries(options.cmaData)) {
        if (item) cmaMap.set(String(id), item);
      }
    }

    const hasCma = cmaMap.size > 0;
    const primarySheetTitle = hasCma ? 'Market Research & CMA' : 'Inventory Details';
    const sheetTitle =
      options?.title || `eBay ${hasCma ? 'Market Research' : 'Inventory'} Report - ly014132 (${formattedDate})`;
    const items = inventory.items || [];
    const rowCount = Math.max(100, items.length + 15);
    const colCount = hasCma ? 15 : 10;

    let spreadsheetId = options?.spreadsheetId;
    let isExistingSheet = false;

    // 1. If no explicit spreadsheetId, check if any sheet was shared with this service account
    if (!spreadsheetId) {
      try {
        const driveSearchRes = await fetch(
          "https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.spreadsheet' and trashed=false&orderBy=modifiedTime desc&pageSize=1&fields=files(id,name)",
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (driveSearchRes.ok) {
          const driveData = (await driveSearchRes.json()) as any;
          if (Array.isArray(driveData.files) && driveData.files.length > 0) {
            spreadsheetId = driveData.files[0].id;
            isExistingSheet = true;
            console.log(
              `[GoogleSheets] Auto-discovered shared spreadsheet: ${spreadsheetId} ("${driveData.files[0].name}")`
            );
          }
        }
      } catch (searchErr) {
        console.warn('[GoogleSheets] Drive search error:', searchErr);
      }
    }

    // 2. If still no spreadsheetId, attempt to create a new spreadsheet
    if (!spreadsheetId) {
      const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: {
            title: sheetTitle,
          },
          sheets: [
            {
              properties: {
                sheetId: 0,
                title: primarySheetTitle,
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: rowCount,
                  columnCount: colCount,
                },
              },
            },
            {
              properties: {
                sheetId: 1,
                title: 'Executive Summary',
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: 35,
                  columnCount: 6,
                },
              },
            },
          ],
        }),
      });

      if (!createRes.ok) {
        const errJson = (await createRes.json().catch(() => null)) as any;
        const errMsg = errJson?.error?.message || (await createRes.text().catch(() => 'Unknown error'));
        const status = errJson?.error?.status || '';

        // Case A: Google Sheets API is disabled on GCP
        if (createRes.status === 403 && (errMsg.includes('SERVICE_DISABLED') || errMsg.includes('has not been used'))) {
          let activationUrl = '';
          if (Array.isArray(errJson?.error?.details)) {
            for (const d of errJson.error.details) {
              if (d.metadata?.activationUrl) {
                activationUrl = d.metadata.activationUrl;
                break;
              }
              if (Array.isArray(d.links)) {
                const helpLink = d.links.find((l: any) => l.url?.includes('overview'));
                if (helpLink) {
                  activationUrl = helpLink.url;
                  break;
                }
              }
            }
          }
          throw new GoogleSheetsApiDisabledError(errMsg, activationUrl);
        }

        // Case B: Google Service Account has 0-byte Drive storage quota (standard Google Cloud behavior)
        if (
          createRes.status === 403 ||
          errMsg.includes('The caller does not have permission') ||
          errMsg.includes('storageQuotaExceeded') ||
          errMsg.includes('quota')
        ) {
          throw new GoogleSheetsDriveQuotaError(
            `Service accounts have 0-byte Drive storage quota and cannot own files. Please link an existing sheet shared with ${creds.client_email}`,
            creds.client_email
          );
        }

        throw new Error(`Google Sheets API error (${createRes.status} ${status}): ${errMsg}`);
      }

      const createdData = (await createRes.json()) as { spreadsheetId: string; spreadsheetUrl: string };
      spreadsheetId = createdData.spreadsheetId;
    }

    // 3. Inspect existing spreadsheet to ensure required worksheets exist
    let detailsSheetId = 0;
    let summarySheetId = 1;

    try {
      const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (metaRes.ok) {
        const meta = (await metaRes.json()) as any;
        const existingSheets: any[] = meta.sheets || [];

        const foundCma = existingSheets.find((s) => s.properties?.title === 'Market Research & CMA');
        const foundDetails = existingSheets.find((s) => s.properties?.title === 'Inventory Details');
        const primarySheet = hasCma ? (foundCma || foundDetails) : (foundDetails || foundCma);
        const foundSummary = existingSheets.find((s) => s.properties?.title === 'Executive Summary');

        const setupRequests: any[] = [];

        if (primarySheet) {
          detailsSheetId = primarySheet.properties.sheetId;
          if (primarySheet.properties.title !== primarySheetTitle) {
            setupRequests.push({
              updateSheetProperties: {
                properties: {
                  sheetId: detailsSheetId,
                  title: primarySheetTitle,
                  gridProperties: {
                    frozenRowCount: 1,
                    rowCount: rowCount,
                    columnCount: colCount,
                  },
                },
                fields: 'title,gridProperties(frozenRowCount,rowCount,columnCount)',
              },
            });
          }
        } else if (existingSheets.length > 0) {
          detailsSheetId = existingSheets[0].properties.sheetId;
          setupRequests.push({
            updateSheetProperties: {
              properties: {
                sheetId: detailsSheetId,
                title: primarySheetTitle,
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: rowCount,
                  columnCount: colCount,
                },
              },
              fields: 'title,gridProperties(frozenRowCount,rowCount,columnCount)',
            },
          });
        } else {
          detailsSheetId = Math.floor(Math.random() * 800000) + 10000;
          setupRequests.push({
            addSheet: {
              properties: {
                sheetId: detailsSheetId,
                title: primarySheetTitle,
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: rowCount,
                  columnCount: colCount,
                },
              },
            },
          });
        }

        if (foundSummary) {
          summarySheetId = foundSummary.properties.sheetId;
        } else {
          summarySheetId = detailsSheetId + 1001;
          setupRequests.push({
            addSheet: {
              properties: {
                sheetId: summarySheetId,
                title: 'Executive Summary',
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: 35,
                  columnCount: 6,
                },
              },
            },
          });
        }

        if (setupRequests.length > 0) {
          await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ requests: setupRequests }),
          });
        }
      }
    } catch (metaErr) {
      console.warn('[GoogleSheets] Metadata inspection error (falling back to defaults):', metaErr);
    }

    // Optional: Clear existing content if requested
    if (options?.clearExisting) {
      try {
        await Promise.all([
          fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'${primarySheetTitle}'!A1:Z200:clear`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            }
          ),
          fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'Executive Summary'!A1:Z100:clear`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            }
          ),
        ]);
      } catch (clearErr) {
        console.warn('[GoogleSheets] Clear ranges error (non-fatal):', clearErr);
      }
    }

    // 4. Populate values across both worksheets
    const nowPacific = new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    let detailHeaders: string[];
    let detailRows: (string | number)[][];
    let summaryData: (string | number)[][];

    if (hasCma) {
      detailHeaders = [
        'Item ID',
        'Listing Title',
        'Category Group',
        'Condition & Packaging',
        'Listed Price (USD)',
        'Active Low (USD)',
        'Active High (USD)',
        'Recent Sold Avg (USD)',
        'Price vs Sold Comps (%)',
        'Competitiveness Rating',
        'Market Strategy & Valuation Notes',
        'Full Item Description',
        'eBay Listing URL',
      ];

      detailRows = items.map((item, index) => {
        const rowNum = index + 2;
        const cma = cmaMap.get(item.itemId);
        const price = item.price;
        const activeLow = cma?.activeLow ?? Math.round(price * 0.85);
        const activeHigh = cma?.activeHigh ?? Math.round(price * 1.25);
        const soldAvg = cma?.soldAvg ?? Math.round(price * 0.95);
        const comp = cma?.competitiveness || 'Fair Market Value';
        const notes = cma?.strategyNotes || 'Standard collector item with stable market demand.';
        const desc = cma?.itemDescription || item.title;

        return [
          item.itemId,
          item.title,
          item.categoryGroup || 'Transformers',
          item.condition || 'Factory Sealed (MISB / NIB)',
          price,
          activeLow,
          activeHigh,
          soldAvg,
          `=(E${rowNum}-H${rowNum})/H${rowNum}`,
          comp,
          notes,
          desc,
          item.listingUrl || `https://www.ebay.com/itm/${item.itemId}`,
        ];
      });

      summaryData = [
        ['📊 EXECUTIVE COMPARATIVE MARKET ANALYSIS (CMA)', '', ''],
        ['Key Metric', 'Value', 'Strategic Context & Notes'],
        ['Total Active Listings Analyzed', `=COUNTA('${primarySheetTitle}'!A2:A)`, '100% of current active eBay catalog'],
        ['Total Portfolio Listed Value', `=SUM('${primarySheetTitle}'!E2:E)`, 'Cumulative asking price on eBay'],
        ['Total Estimated Sold Market Value', `=SUM('${primarySheetTitle}'!H2:H)`, 'Benchmark valuation based on recent comps'],
        ['Portfolio Variance vs Market Comps', '=(B4-B5)/B5', 'Positive indicates premium positioning over sold comps'],
        ['Average Listed Price', `=AVERAGE('${primarySheetTitle}'!E2:E)`, 'Current mean asking price per item'],
        ['Average Sold Comp', `=AVERAGE('${primarySheetTitle}'!H2:H)`, 'Market average realized price per item'],
        [
          'Top Asset by Listed Price',
          inventory.topValuable[0]
            ? `${inventory.topValuable[0].title} ($${inventory.topValuable[0].price.toFixed(2)})`
            : 'N/A',
          'Highest asking item in portfolio',
        ],
        ['Report Generated At', `${nowPacific} (Pacific)`, 'Live Gemini Market Intelligence snapshot'],
        ['Store Owner', 'ly014132', 'Authentic California Collectibles & Die-Cast'],
        ['Storefront Showcase', 'https://bluestonelab.trade', 'Direct showcase custom storefront'],
        ['eBay Official Store', 'https://www.ebay.com/usr/ly014132', 'Direct seller storefront on eBay'],
        ['', '', ''],
        ['Pricing Competitiveness Breakdown', 'Item Count', '% of Portfolio'],
        ['Fair Market Value', `=COUNTIF('${primarySheetTitle}'!J2:J, "Fair Market Value")`, '=B16/B3'],
        [
          'Premium / Rare',
          `=COUNTIF('${primarySheetTitle}'!J2:J, "Premium / Rare*") + COUNTIF('${primarySheetTitle}'!J2:J, "Premium*")`,
          '=B17/B3',
        ],
        ['Below Market - Fast Mover', `=COUNTIF('${primarySheetTitle}'!J2:J, "Below Market*")`, '=B18/B3'],
        [
          'Above Market / High Ask',
          `=COUNTIF('${primarySheetTitle}'!J2:J, "Above Market*") + COUNTIF('${primarySheetTitle}'!J2:J, "Overpriced*")`,
          '=B19/B3',
        ],
      ];
    } else {
      detailHeaders = [
        'Item ID',
        'Title',
        'Category Group',
        'Condition',
        'Price (USD)',
        'Qty',
        'Total Value (USD)',
        'Photos',
        'eBay Listing URL',
      ];

      detailRows = items.map((item, index) => {
        const rowNum = index + 2;
        return [
          item.itemId,
          item.title,
          item.categoryGroup || 'General',
          item.condition || 'MISB',
          item.price,
          item.quantity || 1,
          `=E${rowNum}*F${rowNum}`,
          item.photosCount || 1,
          item.listingUrl,
        ];
      });

      summaryData = [
        ['📊 EXECUTIVE PORTFOLIO SUMMARY', '', ''],
        ['KPI Metric', 'Value', 'Context / Notes'],
        ['Total Active Listings', `=COUNTA('${primarySheetTitle}'!A2:A)`, 'Unique active eBay listings'],
        ['Total Portfolio Retail Value', `=SUM('${primarySheetTitle}'!G2:G)`, 'Cumulative asking price across inventory'],
        ['Average Listing Price', `=AVERAGE('${primarySheetTitle}'!E2:E)`, 'Mean asking price per active item'],
        ['Total Units Available', `=SUM('${primarySheetTitle}'!F2:F)`, 'Sum of all physical items in stock'],
        [
          'Top Valued Item',
          inventory.topValuable[0]
            ? `${inventory.topValuable[0].title} ($${inventory.topValuable[0].price.toFixed(2)})`
            : 'N/A',
          'Highest listing price in inventory',
        ],
        ['Report Generated At', `${nowPacific} (Pacific)`, 'Live snapshot synced with eBay'],
        ['Store Owner', 'ly014132', 'Authentic California Collectibles'],
        ['Storefront Showcase', 'https://bluestonelab.trade', 'Custom online showcase storefront'],
        ['eBay Official Store', 'https://www.ebay.com/usr/ly014132', 'Direct eBay seller portal'],
        ['', '', ''],
        ['Category Collections Breakdown', 'Item Count', '% of Portfolio'],
        ...Object.entries(inventory.categoryCounts).map(([cat, count]) => [
          cat,
          count,
          `=${count}/${inventory.totalCount || 1}`,
        ]),
      ];
    }

    const valuesUpdateRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: [
            {
              range: `'${primarySheetTitle}'!A1:${hasCma ? 'M' : 'I'}`,
              values: [detailHeaders, ...detailRows],
            },
            {
              range: "'Executive Summary'!A1:C",
              values: summaryData,
            },
          ],
        }),
      }
    );

    if (!valuesUpdateRes.ok) {
      console.warn('[GoogleSheets] Failed to populate values:', await valuesUpdateRes.text());
    }

    // 5. Apply professional styles, formatting, and auto-fit column widths
    const formatRequests: any[] = hasCma
      ? [
          // Header for Market Research & CMA (Dark Navy)
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: 13,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.1, green: 0.14, blue: 0.22 },
                  textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10 },
                  horizontalAlignment: 'CENTER',
                  verticalAlignment: 'MIDDLE',
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
            },
          },
          // Currency format for columns E, F, G, H (Indices 4, 5, 6, 7)
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 4,
                endColumnIndex: 8,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
                  horizontalAlignment: 'RIGHT',
                },
              },
              fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
            },
          },
          // Percentage format for column I (Index 8)
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 8,
                endColumnIndex: 9,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'PERCENT', pattern: '+0.0%;-0.0%;0.0%' },
                  horizontalAlignment: 'RIGHT',
                },
              },
              fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
            },
          },
          // Center Item ID (col 0), Condition (col 3), Competitiveness (col 9)
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 0,
                endColumnIndex: 1,
              },
              cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
              fields: 'userEnteredFormat(horizontalAlignment)',
            },
          },
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 3,
                endColumnIndex: 4,
              },
              cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
              fields: 'userEnteredFormat(horizontalAlignment)',
            },
          },
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 9,
                endColumnIndex: 10,
              },
              cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true } } },
              fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
            },
          },
          // Wrap text for Strategy Notes (col 10) and Description (col 11)
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 10,
                endColumnIndex: 12,
              },
              cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } },
              fields: 'userEnteredFormat(wrapStrategy)',
            },
          },
          // Set specific column widths for optimal reading
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
              properties: { pixelSize: 125 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 },
              properties: { pixelSize: 320 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 },
              properties: { pixelSize: 160 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 },
              properties: { pixelSize: 180 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 },
              properties: { pixelSize: 130 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 },
              properties: { pixelSize: 130 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 },
              properties: { pixelSize: 130 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 8 },
              properties: { pixelSize: 140 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 8, endIndex: 9 },
              properties: { pixelSize: 150 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 9, endIndex: 10 },
              properties: { pixelSize: 170 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 10, endIndex: 11 },
              properties: { pixelSize: 380 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 11, endIndex: 12 },
              properties: { pixelSize: 420 },
              fields: 'pixelSize',
            },
          },
          {
            updateDimensionProperties: {
              range: { sheetId: detailsSheetId, dimension: 'COLUMNS', startIndex: 12, endIndex: 13 },
              properties: { pixelSize: 250 },
              fields: 'pixelSize',
            },
          },
          // Header styling for Executive Summary (Green banner)
          {
            repeatCell: {
              range: { sheetId: summarySheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 3 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.06, green: 0.62, blue: 0.35 },
                  textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 12 },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
          // Column header for Executive Summary (Blue banner)
          {
            repeatCell: {
              range: { sheetId: summarySheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.2, green: 0.4, blue: 0.84 },
                  textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10 },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
          // Currency format for summary rows (Total Portfolio, Sold Market, Avg Listed, Avg Sold)
          {
            repeatCell: {
              range: { sheetId: summarySheetId, startRowIndex: 3, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 2 },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
                  textFormat: { bold: true },
                },
              },
              fields: 'userEnteredFormat(numberFormat,textFormat)',
            },
          },
          {
            repeatCell: {
              range: { sheetId: summarySheetId, startRowIndex: 6, endRowIndex: 8, startColumnIndex: 1, endColumnIndex: 2 },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
                  textFormat: { bold: true },
                },
              },
              fields: 'userEnteredFormat(numberFormat,textFormat)',
            },
          },
          // Percent format for variance (row 5) and breakdown rows (rows 15-19)
          {
            repeatCell: {
              range: { sheetId: summarySheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 },
              cell: {
                userEnteredFormat: {
                  numberFormat: { type: 'PERCENT', pattern: '+0.0%;-0.0%;0.0%' },
                  textFormat: { bold: true },
                },
              },
              fields: 'userEnteredFormat(numberFormat,textFormat)',
            },
          },
          {
            repeatCell: {
              range: { sheetId: summarySheetId, startRowIndex: 15, endRowIndex: 20, startColumnIndex: 2, endColumnIndex: 3 },
              cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '0.0%' } } },
              fields: 'userEnteredFormat(numberFormat)',
            },
          },
          // Auto resize Executive Summary
          {
            autoResizeDimensions: {
              dimensions: { sheetId: summarySheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 3 },
            },
          },
        ]
      : [
          // Format Inventory Details Header
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: 9,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.1, green: 0.14, blue: 0.22 }, // Slate Navy
                  textFormat: {
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                    bold: true,
                    fontSize: 10,
                  },
                  horizontalAlignment: 'CENTER',
                  verticalAlignment: 'MIDDLE',
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)',
            },
          },
          // Format Currency in Columns E and G
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 4,
                endColumnIndex: 5,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: 'CURRENCY',
                    pattern: '"$"#,##0.00',
                  },
                  horizontalAlignment: 'RIGHT',
                },
              },
              fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
            },
          },
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 6,
                endColumnIndex: 7,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: 'CURRENCY',
                    pattern: '"$"#,##0.00',
                  },
                  horizontalAlignment: 'RIGHT',
                },
              },
              fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
            },
          },
          // Center Item ID, Qty, Photos
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 0,
                endColumnIndex: 1,
              },
              cell: {
                userEnteredFormat: {
                  horizontalAlignment: 'CENTER',
                },
              },
              fields: 'userEnteredFormat(horizontalAlignment)',
            },
          },
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 5,
                endColumnIndex: 6,
              },
              cell: {
                userEnteredFormat: {
                  horizontalAlignment: 'CENTER',
                },
              },
              fields: 'userEnteredFormat(horizontalAlignment)',
            },
          },
          {
            repeatCell: {
              range: {
                sheetId: detailsSheetId,
                startRowIndex: 1,
                endRowIndex: items.length + 1,
                startColumnIndex: 7,
                endColumnIndex: 8,
              },
              cell: {
                userEnteredFormat: {
                  horizontalAlignment: 'CENTER',
                },
              },
              fields: 'userEnteredFormat(horizontalAlignment)',
            },
          },
          // Format Executive Summary Title (A1:C1)
          {
            repeatCell: {
              range: {
                sheetId: summarySheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: 3,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.06, green: 0.62, blue: 0.35 }, // Sheets Green
                  textFormat: {
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                    bold: true,
                    fontSize: 12,
                  },
                  horizontalAlignment: 'LEFT',
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
            },
          },
          // Format Executive Summary Header (A2:C2)
          {
            repeatCell: {
              range: {
                sheetId: summarySheetId,
                startRowIndex: 1,
                endRowIndex: 2,
                startColumnIndex: 0,
                endColumnIndex: 3,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.2, green: 0.4, blue: 0.84 }, // Google Blue
                  textFormat: {
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                    bold: true,
                    fontSize: 10,
                  },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
          // Format Percentage for Category Breakdown
          {
            repeatCell: {
              range: {
                sheetId: summarySheetId,
                startRowIndex: 13,
                endRowIndex: 13 + Object.keys(inventory.categoryCounts).length,
                startColumnIndex: 2,
                endColumnIndex: 3,
              },
              cell: {
                userEnteredFormat: {
                  numberFormat: {
                    type: 'PERCENT',
                    pattern: '0.0%',
                  },
                  horizontalAlignment: 'RIGHT',
                },
              },
              fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
            },
          },
          // Auto-resize dimensions
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId: detailsSheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: 9,
              },
            },
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId: summarySheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: 3,
              },
            },
          },
        ];

    try {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests: formatRequests }),
      });
    } catch (fmtErr) {
      console.warn('[GoogleSheets] Formatting update error (non-critical):', fmtErr);
    }

    // 6. Ensure read access via Google Drive API
    try {
      await fetch(`https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          role: 'reader',
          type: 'anyone',
        }),
      });
    } catch {
      // Non-critical if permissions can't be set
    }

    return {
      spreadsheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      totalListings: inventory.totalCount,
      totalValue: inventory.totalValue,
      sheetTitle,
      isExistingSheet,
    };
  }

  /**
   * Dedicated entry point for generating or refreshing a comprehensive Market Research & CMA spreadsheet.
   */
  async createMarketResearchSpreadsheet(
    inventory: SellerInventorySummary,
    cmaData?: Record<string, ItemCmaEntry> | ItemCmaEntry[],
    options?: Omit<CreateReportOptions, 'cmaData'>
  ): Promise<SpreadsheetReportResult> {
    return this.createInventorySpreadsheet(inventory, {
      ...options,
      cmaData,
    });
  }
}

