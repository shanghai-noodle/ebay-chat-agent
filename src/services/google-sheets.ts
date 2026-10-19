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

export interface CreateReportOptions {
  title?: string;
  userEmail?: string;
  spreadsheetId?: string;
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
    const sheetTitle = options?.title || `eBay Inventory Report - ly014132 (${formattedDate})`;
    const items = inventory.items || [];
    const rowCount = Math.max(100, items.length + 15);

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
                title: 'Inventory Details',
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: rowCount,
                  columnCount: 10,
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

        const foundDetails = existingSheets.find((s) => s.properties?.title === 'Inventory Details');
        const foundSummary = existingSheets.find((s) => s.properties?.title === 'Executive Summary');

        const setupRequests: any[] = [];

        if (foundDetails) {
          detailsSheetId = foundDetails.properties.sheetId;
        } else if (existingSheets.length > 0) {
          // Rename the first default sheet (e.g. "Sheet1") to "Inventory Details"
          detailsSheetId = existingSheets[0].properties.sheetId;
          setupRequests.push({
            updateSheetProperties: {
              properties: {
                sheetId: detailsSheetId,
                title: 'Inventory Details',
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: rowCount,
                  columnCount: 10,
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
                title: 'Inventory Details',
                gridProperties: {
                  frozenRowCount: 1,
                  rowCount: rowCount,
                  columnCount: 10,
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

    // 4. Populate values across both worksheets
    const detailHeaders = [
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

    const detailRows = items.map((item, index) => {
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

    const nowPacific = new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const summaryData: (string | number)[][] = [
      ['📊 EXECUTIVE PORTFOLIO SUMMARY', '', ''],
      ['KPI Metric', 'Value', 'Context / Notes'],
      ['Total Active Listings', "=COUNTA('Inventory Details'!A2:A)", 'Unique active eBay listings'],
      ['Total Portfolio Retail Value', "=SUM('Inventory Details'!G2:G)", 'Cumulative asking price across inventory'],
      ['Average Listing Price', "=AVERAGE('Inventory Details'!E2:E)", 'Mean asking price per active item'],
      ['Total Units Available', "=SUM('Inventory Details'!F2:F)", 'Sum of all physical items in stock'],
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
              range: "'Inventory Details'!A1:I",
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
    const formatRequests: any[] = [
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
}
