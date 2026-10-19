import { GoogleChatMediaService, ServiceAccountCredentials } from './google-chat/media';
import { ActiveListingItem, SellerInventorySummary } from './ebay/trading';

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
  suggestedPrice?: number;
}

export interface SheetLayoutConfig {
  columnOrder?: string[];
  moveColumns?: Array<{ column: string; toPosition: string | number }>;
  columnsToAdd?: Array<{ column?: string; id?: string; title?: string; position?: string | number }>;
  columnsToRemove?: string[];
  colorCodeColumns?: string[];
  rowHeight?: number;
}

export interface CreateReportOptions {
  title?: string;
  userEmail?: string;
  spreadsheetId?: string;
  clearExisting?: boolean;
  cmaData?: Record<string, ItemCmaEntry> | ItemCmaEntry[];
  layout?: SheetLayoutConfig;
}

export interface SpreadsheetReportResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  totalListings: number;
  totalValue: number;
  sheetTitle: string;
  isExistingSheet?: boolean;
  columns?: string[];
}

export interface SheetRowContext {
  rowNum: number;
  cma?: ItemCmaEntry;
  cmaMap: Map<string, ItemCmaEntry>;
  colLetters: Record<string, string>;
  primarySheetTitle: string;
  summarySheetTitle: string;
}

export interface SheetColumnDef {
  id: string;
  title: string;
  aliases: string[];
  width: number;
  align?: 'LEFT' | 'CENTER' | 'RIGHT';
  valign?: 'TOP' | 'MIDDLE' | 'BOTTOM';
  bold?: boolean;
  wrap?: boolean;
  numberFormat?: { type: string; pattern: string };
  getValue: (item: ActiveListingItem, index: number, ctx: SheetRowContext) => any;
}

export function getColumnLetter(colIndex: number): string {
  let letter = '';
  let temp = colIndex;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

export function computeSuggestedPrice(price: number, cma?: ItemCmaEntry): number {
  if (!cma) return price;
  if (cma.suggestedPrice && typeof cma.suggestedPrice === 'number') return cma.suggestedPrice;
  const comp = cma.competitiveness || '';
  const sold = cma.soldAvg || price * 0.95;
  const low = cma.activeLow || price * 0.85;

  let suggested = price;
  if (comp.includes('Premium') || comp.includes('Rare')) {
    suggested = price;
  } else if (comp.includes('Above Market') || comp.includes('Overpriced') || comp.includes('High Ask')) {
    const target = Math.max(low, sold * 1.1);
    suggested = Math.round(Math.min(price * 0.88, target) * 100) / 100;
  } else if (comp.includes('Below Market') || comp.includes('Fast Mover')) {
    suggested = Math.round(Math.max(price, sold) * 100) / 100;
  } else {
    if (price > sold * 1.15) {
      suggested = Math.round(sold * 1.08 * 100) / 100;
    } else {
      suggested = price;
    }
  }
  return Math.round(suggested * 100) / 100;
}

function findColumnDef(columns: SheetColumnDef[], token: string): SheetColumnDef | undefined {
  const norm = token.toLowerCase().trim().replace(/['"]/g, '');
  return columns.find(
    (c) =>
      c.id.toLowerCase() === norm ||
      c.title.toLowerCase() === norm ||
      c.aliases.some((a) => norm.includes(a) || a.includes(norm))
  );
}

function getAvailableColumns(): SheetColumnDef[] {
  return [
    {
      id: 'listingUrl',
      title: 'eBay Listing Link',
      aliases: ['listing url', 'item link', 'ebay link', 'url', 'link', 'ebay listing url'],
      width: 220,
      align: 'CENTER',
      valign: 'MIDDLE',
      getValue: (item) => item.listingUrl || `https://www.ebay.com/itm/${item.itemId}`,
    },
    {
      id: 'thumbnail',
      title: 'Thumbnail',
      aliases: ['thumbnail', 'item thumbnail', 'image', 'photo', 'picture'],
      width: 85,
      align: 'CENTER',
      valign: 'MIDDLE',
      getValue: (item) => (item.imageUrl ? `=IMAGE("${item.imageUrl}")` : ''),
    },
    {
      id: 'itemId',
      title: 'Item ID',
      aliases: ['item id', 'id', 'item_id'],
      width: 125,
      align: 'CENTER',
      valign: 'MIDDLE',
      getValue: (item) => item.itemId,
    },
    {
      id: 'title',
      title: 'Listing Title',
      aliases: ['listing title', 'title', 'name'],
      width: 320,
      align: 'LEFT',
      valign: 'MIDDLE',
      getValue: (item) => item.title,
    },
    {
      id: 'category',
      title: 'Category Group',
      aliases: ['category group', 'category'],
      width: 160,
      align: 'LEFT',
      valign: 'MIDDLE',
      getValue: (item) => item.categoryGroup || 'Transformers',
    },
    {
      id: 'condition',
      title: 'Condition & Packaging',
      aliases: ['condition & packaging', 'condition', 'packaging'],
      width: 180,
      align: 'CENTER',
      valign: 'MIDDLE',
      getValue: (item) => item.condition || 'Factory Sealed (MISB / NIB)',
    },
    {
      id: 'listedPrice',
      title: 'Listed Price (USD)',
      aliases: ['listed price', 'price', 'retail price'],
      width: 130,
      align: 'RIGHT',
      valign: 'MIDDLE',
      numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
      getValue: (item) => item.price,
    },
    {
      id: 'activeLow',
      title: 'Active Low (USD)',
      aliases: ['active low', 'low price', 'low comp'],
      width: 130,
      align: 'RIGHT',
      valign: 'MIDDLE',
      numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
      getValue: (item, _i, ctx) => ctx.cma?.activeLow ?? Math.round(item.price * 0.85),
    },
    {
      id: 'activeHigh',
      title: 'Active High (USD)',
      aliases: ['active high', 'high price', 'high comp'],
      width: 130,
      align: 'RIGHT',
      valign: 'MIDDLE',
      numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
      getValue: (item, _i, ctx) => ctx.cma?.activeHigh ?? Math.round(item.price * 1.25),
    },
    {
      id: 'soldAvg',
      title: 'Recent Sold Avg (USD)',
      aliases: ['recent sold avg', 'sold avg', 'sold comp', 'comps average'],
      width: 140,
      align: 'RIGHT',
      valign: 'MIDDLE',
      numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
      getValue: (item, _i, ctx) => ctx.cma?.soldAvg ?? Math.round(item.price * 0.95),
    },
    {
      id: 'compsVariance',
      title: 'Price vs Sold Comps (%)',
      aliases: ['price vs sold comps', 'variance', 'comps variance'],
      width: 150,
      align: 'RIGHT',
      valign: 'MIDDLE',
      numberFormat: { type: 'PERCENT', pattern: '+0.0%;-0.0%;0.0%' },
      getValue: (_item, _i, ctx) => {
        const lp = ctx.colLetters['listedPrice'];
        const sa = ctx.colLetters['soldAvg'];
        if (lp && sa) return `=( ${lp}${ctx.rowNum}-${sa}${ctx.rowNum} )/${sa}${ctx.rowNum}`;
        return 0;
      },
    },
    {
      id: 'competitiveness',
      title: 'Competitiveness Rating',
      aliases: ['competitiveness rating', 'competitiveness', 'rating'],
      width: 175,
      align: 'CENTER',
      valign: 'MIDDLE',
      bold: true,
      getValue: (item, _i, ctx) => ctx.cma?.competitiveness || 'Fair Market Value',
    },
    {
      id: 'suggestedPrice',
      title: 'Gemini Suggested Price (USD)',
      aliases: ['gemini suggested price', 'suggested price', 'recommended price'],
      width: 160,
      align: 'RIGHT',
      valign: 'MIDDLE',
      bold: true,
      numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
      getValue: (item, _i, ctx) => computeSuggestedPrice(item.price, ctx.cma),
    },
    {
      id: 'suggestedAdjustment',
      title: 'Gemini Suggested Price Adjustment (USD)',
      aliases: ['gemini suggested price adjustment', 'suggested price adjustment', 'price adjustment', 'adjustment'],
      width: 185,
      align: 'RIGHT',
      valign: 'MIDDLE',
      bold: true,
      numberFormat: { type: 'CURRENCY', pattern: '+$#,##0.00;-$#,##0.00;"$0.00"' },
      getValue: (item, _i, ctx) => {
        const sp = ctx.colLetters['suggestedPrice'];
        const lp = ctx.colLetters['listedPrice'];
        if (sp && lp) return `=${sp}${ctx.rowNum}-${lp}${ctx.rowNum}`;
        const s = computeSuggestedPrice(item.price, ctx.cma);
        return Math.round((s - item.price) * 100) / 100;
      },
    },
    {
      id: 'strategyNotes',
      title: 'Market Strategy & Valuation Notes',
      aliases: ['market strategy & valuation notes', 'strategy notes', 'valuation notes'],
      width: 380,
      align: 'LEFT',
      valign: 'MIDDLE',
      wrap: true,
      getValue: (item, _i, ctx) => ctx.cma?.strategyNotes || 'Standard collector item with stable market demand.',
    },
    {
      id: 'itemDescription',
      title: 'Full Item Description',
      aliases: ['full item description', 'item description', 'description'],
      width: 420,
      align: 'LEFT',
      valign: 'MIDDLE',
      wrap: true,
      getValue: (item, _i, ctx) => ctx.cma?.itemDescription || item.title,
    },
    {
      id: 'quantity',
      title: 'Quantity Available',
      aliases: ['quantity', 'qty', 'stock'],
      width: 100,
      align: 'CENTER',
      valign: 'MIDDLE',
      getValue: (item) => item.quantity || 1,
    },
    {
      id: 'totalValue',
      title: 'Total Value (USD)',
      aliases: ['total value', 'inventory value'],
      width: 140,
      align: 'RIGHT',
      valign: 'MIDDLE',
      numberFormat: { type: 'CURRENCY', pattern: '"$"#,##0.00' },
      getValue: (item, _i, ctx) => {
        const lp = ctx.colLetters['listedPrice'];
        const q = ctx.colLetters['quantity'];
        if (lp && q) return `=${lp}${ctx.rowNum}*${q}${ctx.rowNum}`;
        return item.price * (item.quantity || 1);
      },
    },
    {
      id: 'photosCount',
      title: 'Photos Count',
      aliases: ['photos count', 'photos', 'images'],
      width: 100,
      align: 'CENTER',
      valign: 'MIDDLE',
      getValue: (item) => item.photosCount || 1,
    },
  ];
}

function resolveColumnList(
  availableColumns: SheetColumnDef[],
  defaultIds: string[],
  layout?: SheetLayoutConfig
): SheetColumnDef[] {
  let activeIds = [...defaultIds];

  if (layout?.columnOrder && layout.columnOrder.length > 0) {
    const customOrderedIds: string[] = [];
    for (const token of layout.columnOrder) {
      const match = findColumnDef(availableColumns, token);
      if (match && !customOrderedIds.includes(match.id)) {
        customOrderedIds.push(match.id);
      }
    }
    if (customOrderedIds.length > 0) {
      activeIds = customOrderedIds;
    }
  }

  // Handle moveColumns
  if (layout?.moveColumns && Array.isArray(layout.moveColumns)) {
    for (const move of layout.moveColumns) {
      const match = findColumnDef(availableColumns, move.column);
      if (match) {
        activeIds = activeIds.filter((id) => id !== match.id);
        const targetPos = String(move.toPosition).toLowerCase();
        if (targetPos === 'first' || targetPos === '0' || targetPos === '1') {
          activeIds.unshift(match.id);
        } else if (targetPos === 'second' || targetPos === '2') {
          activeIds.splice(1, 0, match.id);
        } else if (targetPos === 'last') {
          activeIds.push(match.id);
        } else {
          const num = parseInt(targetPos, 10);
          const idx = isNaN(num) ? 0 : Math.max(0, num - 1);
          activeIds.splice(idx, 0, match.id);
        }
      }
    }
  }

  // Handle columnsToAdd
  if (layout?.columnsToAdd && Array.isArray(layout.columnsToAdd)) {
    for (const add of layout.columnsToAdd) {
      const colName = add.column || add.title || add.id || '';
      const match = findColumnDef(availableColumns, colName);
      const colId = match ? match.id : 'custom_' + colName.toLowerCase().replace(/[^a-z0-9]/g, '_');

      if (!match) {
        availableColumns.push({
          id: colId,
          title: colName,
          aliases: [colName.toLowerCase()],
          width: 180,
          align: 'LEFT',
          valign: 'MIDDLE',
          wrap: true,
          getValue: () => '',
        });
      }

      activeIds = activeIds.filter((id) => id !== colId);
      const pos = String(add.position || 'last').toLowerCase();
      if (pos === 'first' || pos === '0' || pos === '1') {
        activeIds.unshift(colId);
      } else if (pos === 'second' || pos === '2') {
        activeIds.splice(1, 0, colId);
      } else if (pos === 'last') {
        activeIds.push(colId);
      } else {
        const num = parseInt(pos, 10);
        const idx = isNaN(num) ? activeIds.length : Math.max(0, num - 1);
        activeIds.splice(idx, 0, colId);
      }
    }
  }

  // Handle columnsToRemove
  if (layout?.columnsToRemove && Array.isArray(layout.columnsToRemove)) {
    for (const rem of layout.columnsToRemove) {
      const match = findColumnDef(availableColumns, rem);
      if (match) {
        activeIds = activeIds.filter((id) => id !== match.id);
      }
    }
  }

  return activeIds
    .map((id) => availableColumns.find((c) => c.id === id))
    .filter((c): c is SheetColumnDef => Boolean(c));
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
   * 4. Dynamic column reordering, custom columns, thumbnails, and color-coded conditional formatting.
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

    // Resolve dynamic active columns
    const availableColumns = getAvailableColumns();
    const defaultBaseline = hasCma
      ? [
          'listingUrl',
          'thumbnail',
          'itemId',
          'title',
          'category',
          'condition',
          'listedPrice',
          'activeLow',
          'activeHigh',
          'soldAvg',
          'compsVariance',
          'competitiveness',
          'suggestedPrice',
          'suggestedAdjustment',
          'strategyNotes',
          'itemDescription',
        ]
      : [
          'itemId',
          'title',
          'category',
          'condition',
          'listedPrice',
          'quantity',
          'totalValue',
          'photosCount',
          'listingUrl',
        ];

    const activeColumns = resolveColumnList(availableColumns, defaultBaseline, options?.layout);
    const colCount = Math.max(activeColumns.length, 16);

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

        if (createRes.status === 403 && (errMsg.includes('SERVICE_DISABLED') || errMsg.includes('has not been used'))) {
          let activationUrl = '';
          if (Array.isArray(errJson?.error?.details)) {
            for (const d of errJson.error.details) {
              if (d.metadata?.activationUrl) {
                activationUrl = d.metadata.activationUrl;
                break;
              }
            }
          }
          throw new GoogleSheetsApiDisabledError(errMsg, activationUrl);
        }

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
        const primarySheet = hasCma ? foundCma || foundDetails : foundDetails || foundCma;
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

    // 4. Clear existing content if requested
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

    // 5. Populate values dynamically across both worksheets
    const nowPacific = new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const colLetters: Record<string, string> = {};
    activeColumns.forEach((col, idx) => {
      colLetters[col.id] = getColumnLetter(idx);
    });

    const detailHeaders = activeColumns.map((col) => col.title);
    const detailRows = items.map((item, index) => {
      const rowNum = index + 2;
      const cma = cmaMap.get(item.itemId);
      const ctx: SheetRowContext = {
        rowNum,
        cma,
        cmaMap,
        colLetters,
        primarySheetTitle,
        summarySheetTitle: 'Executive Summary',
      };
      return activeColumns.map((col) => col.getValue(item, index, ctx));
    });

    const lpCol = colLetters['listedPrice'] || 'G';
    const saCol = colLetters['soldAvg'] || 'J';
    const spCol = colLetters['suggestedPrice'] || lpCol;
    const compCol = colLetters['competitiveness'] || 'L';
    const idCol = colLetters['itemId'] || 'C';

    const summaryData: (string | number)[][] = hasCma
      ? [
          ['📊 EXECUTIVE COMPARATIVE MARKET ANALYSIS (CMA)', '', ''],
          ['Key Metric', 'Value', 'Strategic Context & Notes'],
          ['Total Active Listings Analyzed', `=COUNTA('${primarySheetTitle}'!${idCol}2:${idCol})`, '100% of current active eBay catalog'],
          ['Total Portfolio Listed Value', `=SUM('${primarySheetTitle}'!${lpCol}2:${lpCol})`, 'Cumulative asking price on eBay'],
          ['Total Estimated Sold Market Value', `=SUM('${primarySheetTitle}'!${saCol}2:${saCol})`, 'Benchmark valuation based on recent comps'],
          ['Total Gemini Suggested Portfolio Value', `=SUM('${primarySheetTitle}'!${spCol}2:${spCol})`, 'Optimized target valuation across all listings'],
          ['Portfolio Variance vs Market Comps', '=(B4-B5)/B5', 'Positive indicates premium positioning over sold comps'],
          ['Average Listed Price', `=AVERAGE('${primarySheetTitle}'!${lpCol}2:${lpCol})`, 'Current mean asking price per item'],
          ['Average Sold Comp', `=AVERAGE('${primarySheetTitle}'!${saCol}2:${saCol})`, 'Market average realized price per item'],
          ['Average Gemini Suggested Price', `=AVERAGE('${primarySheetTitle}'!${spCol}2:${spCol})`, 'Recommended optimal price per item'],
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
          ['Fair Market Value', `=COUNTIF('${primarySheetTitle}'!${compCol}2:${compCol}, "Fair Market Value")`, '=B18/B3'],
          [
            'Premium / Rare',
            `=COUNTIF('${primarySheetTitle}'!${compCol}2:${compCol}, "Premium / Rare*") + COUNTIF('${primarySheetTitle}'!${compCol}2:${compCol}, "Premium*")`,
            '=B19/B3',
          ],
          ['Below Market - Fast Mover', `=COUNTIF('${primarySheetTitle}'!${compCol}2:${compCol}, "Below Market*")`, '=B20/B3'],
          [
            'Above Market / High Ask',
            `=COUNTIF('${primarySheetTitle}'!${compCol}2:${compCol}, "Above Market*") + COUNTIF('${primarySheetTitle}'!${compCol}2:${compCol}, "Overpriced*")`,
            '=B21/B3',
          ],
        ]
      : [
          ['📊 EXECUTIVE PORTFOLIO SUMMARY', '', ''],
          ['KPI Metric', 'Value', 'Context / Notes'],
          ['Total Active Listings', `=COUNTA('${primarySheetTitle}'!${idCol}2:${idCol})`, 'Unique active eBay listings'],
          ['Total Portfolio Retail Value', `=SUM('${primarySheetTitle}'!${colLetters['totalValue'] || 'G'}2:${colLetters['totalValue'] || 'G'})`, 'Cumulative asking price across inventory'],
          ['Average Listing Price', `=AVERAGE('${primarySheetTitle}'!${lpCol}2:${lpCol})`, 'Mean asking price per active item'],
          ['Total Units Available', `=SUM('${primarySheetTitle}'!${colLetters['quantity'] || 'F'}2:${colLetters['quantity'] || 'F'})`, 'Sum of all physical items in stock'],
          [
            'Top Valued Item',
            inventory.topValuable[0]
              ? `${inventory.topValuable[0].title} ($${inventory.topValuable[0].price.toFixed(2)})`
              : 'N/A',
            'Highest asking item in portfolio',
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

    const lastColLetter = getColumnLetter(activeColumns.length - 1);
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
              range: `'${primarySheetTitle}'!A1:${lastColLetter}`,
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

    // 6. Apply dynamic professional styles, formatting, column widths, row heights, and conditional formatting
    const formatRequests: any[] = [
      // Header for primary sheet (Dark Navy)
      {
        repeatCell: {
          range: {
            sheetId: detailsSheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: 0,
            endColumnIndex: activeColumns.length,
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
    ];

    // If thumbnail column is included, set comfortable row heights
    const hasThumbnail = activeColumns.some((c) => c.id === 'thumbnail');
    if (hasThumbnail || options?.layout?.rowHeight) {
      const rowHeight = options?.layout?.rowHeight || 56;
      formatRequests.push({
        updateDimensionProperties: {
          range: {
            sheetId: detailsSheetId,
            dimension: 'ROWS',
            startIndex: 1,
            endIndex: items.length + 1,
          },
          properties: { pixelSize: rowHeight },
          fields: 'pixelSize',
        },
      });
    }

    // Format each active column
    activeColumns.forEach((col, idx) => {
      // Column width
      formatRequests.push({
        updateDimensionProperties: {
          range: {
            sheetId: detailsSheetId,
            dimension: 'COLUMNS',
            startIndex: idx,
            endIndex: idx + 1,
          },
          properties: { pixelSize: col.width },
          fields: 'pixelSize',
        },
      });

      const userFormat: any = {};
      const fields: string[] = [];

      if (col.align) {
        userFormat.horizontalAlignment = col.align;
        fields.push('horizontalAlignment');
      }
      if (col.valign) {
        userFormat.verticalAlignment = col.valign;
        fields.push('verticalAlignment');
      }
      if (col.bold) {
        userFormat.textFormat = { bold: true };
        fields.push('textFormat');
      }
      if (col.wrap) {
        userFormat.wrapStrategy = 'WRAP';
        fields.push('wrapStrategy');
      }
      if (col.numberFormat) {
        userFormat.numberFormat = col.numberFormat;
        fields.push('numberFormat');
      }

      if (fields.length > 0) {
        formatRequests.push({
          repeatCell: {
            range: {
              sheetId: detailsSheetId,
              startRowIndex: 1,
              endRowIndex: items.length + 1,
              startColumnIndex: idx,
              endColumnIndex: idx + 1,
            },
            cell: { userEnteredFormat: userFormat },
            fields: `userEnteredFormat(${fields.join(',')})`,
          },
        });
      }
    });

    // Color-code requested columns (default: Competitiveness Rating)
    const colorCodeTargets = options?.layout?.colorCodeColumns || ['competitiveness', 'Competitiveness Rating'];
    const compColIdx = activeColumns.findIndex((c) =>
      colorCodeTargets.some(
        (target) =>
          c.id.toLowerCase() === target.toLowerCase() ||
          c.title.toLowerCase() === target.toLowerCase() ||
          c.aliases.some((a) => target.toLowerCase().includes(a))
      )
    );

    if (compColIdx >= 0) {
      const compRange = {
        sheetId: detailsSheetId,
        startRowIndex: 1,
        endRowIndex: items.length + 1,
        startColumnIndex: compColIdx,
        endColumnIndex: compColIdx + 1,
      };

      formatRequests.push(
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [compRange],
              booleanRule: {
                condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Fair Market' }] },
                format: {
                  backgroundColor: { red: 0.9, green: 0.96, blue: 0.92 }, // Soft Green #E6F4EA
                  textFormat: { foregroundColor: { red: 0.07, green: 0.45, blue: 0.2 }, bold: true }, // #137333
                },
              },
            },
            index: 0,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [compRange],
              booleanRule: {
                condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Premium' }] },
                format: {
                  backgroundColor: { red: 0.95, green: 0.91, blue: 0.99 }, // Soft Purple #F3E8FD
                  textFormat: { foregroundColor: { red: 0.46, green: 0.15, blue: 0.73 }, bold: true }, // #7627BB
                },
              },
            },
            index: 1,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [compRange],
              booleanRule: {
                condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Below Market' }] },
                format: {
                  backgroundColor: { red: 1.0, green: 0.97, blue: 0.88 }, // Soft Amber #FEF7E0
                  textFormat: { foregroundColor: { red: 0.69, green: 0.38, blue: 0.0 }, bold: true }, // #B06000
                },
              },
            },
            index: 2,
          },
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [compRange],
              booleanRule: {
                condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Above Market' }] },
                format: {
                  backgroundColor: { red: 0.99, green: 0.91, blue: 0.9 }, // Soft Coral #FCE8E6
                  textFormat: { foregroundColor: { red: 0.77, green: 0.13, blue: 0.12 }, bold: true }, // #C5221F
                },
              },
            },
            index: 3,
          },
        }
      );
    }

    // Format Executive Summary
    formatRequests.push(
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
              backgroundColor: { red: 0.06, green: 0.62, blue: 0.35 },
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 12 },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      },
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
              backgroundColor: { red: 0.2, green: 0.4, blue: 0.84 },
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10 },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      },
      {
        repeatCell: {
          range: {
            sheetId: summarySheetId,
            startRowIndex: 3,
            endRowIndex: 6,
            startColumnIndex: 1,
            endColumnIndex: 2,
          },
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
          range: {
            sheetId: summarySheetId,
            startRowIndex: 7,
            endRowIndex: 10,
            startColumnIndex: 1,
            endColumnIndex: 2,
          },
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
          range: {
            sheetId: summarySheetId,
            startRowIndex: 6,
            endRowIndex: 7,
            startColumnIndex: 1,
            endColumnIndex: 2,
          },
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
          range: {
            sheetId: summarySheetId,
            startRowIndex: 17,
            endRowIndex: 22,
            startColumnIndex: 2,
            endColumnIndex: 3,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'PERCENT', pattern: '0.0%' },
            },
          },
          fields: 'userEnteredFormat(numberFormat)',
        },
      },
      {
        autoResizeDimensions: {
          dimensions: { sheetId: summarySheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 3 },
        },
      }
    );

    try {
      const formatRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests: formatRequests }),
      });
      if (!formatRes.ok) {
        console.warn('[GoogleSheets] Formatting update error (non-critical):', await formatRes.text());
      }
    } catch (fmtErr) {
      console.warn('[GoogleSheets] Formatting update network error (non-critical):', fmtErr);
    }

    // 7. Ensure read access via Google Drive API
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
      columns: activeColumns.map((c) => c.id),
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
