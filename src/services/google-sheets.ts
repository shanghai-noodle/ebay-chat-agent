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

export interface CreateReportOptions {
  title?: string;
  userEmail?: string;
}

export interface SpreadsheetReportResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  totalListings: number;
  totalValue: number;
  sheetTitle: string;
}

export class GoogleSheetsService {
  constructor(private serviceAccountConfig: string | ServiceAccountCredentials) {}

  private getCredentials(): ServiceAccountCredentials {
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
   * Generates a fully formatted, executive-ready Google Sheets inventory report
   * and configures public/user permissions via Google Drive API.
   */
  async createInventorySpreadsheet(
    inventory: SellerInventorySummary,
    options?: CreateReportOptions
  ): Promise<SpreadsheetReportResult> {
    const token = await this.getAccessToken();

    const formattedDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const sheetTitle = options?.title || `eBay Inventory Report - ly014132 (${formattedDate})`;

    const items = inventory.items || [];
    const rowCount = Math.max(100, items.length + 15);

    // 1. Create Spreadsheet with two structured worksheets
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

      if (createRes.status === 403 || errMsg.includes('SERVICE_DISABLED') || errMsg.includes('has not been used')) {
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

      throw new Error(`Google Sheets API error (${createRes.status} ${status}): ${errMsg}`);
    }

    const createdData = (await createRes.json()) as { spreadsheetId: string; spreadsheetUrl: string };
    const spreadsheetId = createdData.spreadsheetId;

    // 2. Populate values across both sheets
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
      ['Top Valued Item', inventory.topValuable[0] ? `${inventory.topValuable[0].title} ($${inventory.topValuable[0].price.toFixed(2)})` : 'N/A', 'Highest listing price in inventory'],
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

    // 3. Apply professional styles, formatting, and auto-fit column widths
    const formatRequests: any[] = [
      // Format Inventory Details Header (A1:I1)
      {
        repeatCell: {
          range: {
            sheetId: 0,
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
      // Format Currency in Columns E (index 4) and G (index 6) for all item rows
      {
        repeatCell: {
          range: {
            sheetId: 0,
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
            sheetId: 0,
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
            sheetId: 0,
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
            sheetId: 0,
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
            sheetId: 0,
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
            sheetId: 1,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: 3,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.06, green: 0.62, blue: 0.35 }, // Google Sheets Green
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
            sheetId: 1,
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
      // Format Percentage for Category Breakdown (Sheet 1, Column C, rows 13 to end)
      {
        repeatCell: {
          range: {
            sheetId: 1,
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
      // Auto-resize dimensions for Inventory Details (columns 0-8)
      {
        autoResizeDimensions: {
          dimensions: {
            sheetId: 0,
            dimension: 'COLUMNS',
            startIndex: 0,
            endIndex: 9,
          },
        },
      },
      // Auto-resize dimensions for Executive Summary (columns 0-3)
      {
        autoResizeDimensions: {
          dimensions: {
            sheetId: 1,
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
      console.warn('[GoogleSheets] Formatting update failed (non-critical):', fmtErr);
    }

    // 4. Grant access via Google Drive API
    // 4a. Public read access with link (allows instant 1-click viewing in browser)
    try {
      const permRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            role: 'reader',
            type: 'anyone',
          }),
        }
      );
      if (!permRes.ok) {
        console.warn('[GoogleSheets] Drive permission set failed:', await permRes.text());
      }
    } catch (permErr) {
      console.warn('[GoogleSheets] Drive permission exception:', permErr);
    }

    // 4b. If user email is present, grant writer access
    if (options?.userEmail && options.userEmail.includes('@')) {
      try {
        await fetch(
          `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?sendNotificationEmail=false`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              role: 'writer',
              type: 'user',
              emailAddress: options.userEmail,
            }),
          }
        );
      } catch {
        // Ignore user permission grant failure (public read link already works)
      }
    }

    return {
      spreadsheetId,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      totalListings: inventory.totalCount,
      totalValue: inventory.totalValue,
      sheetTitle,
    };
  }
}
