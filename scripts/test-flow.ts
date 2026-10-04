import fs from 'node:fs';
import path from 'node:path';
import { GeminiService } from '../src/services/gemini';

/**
 * Local test script to verify Gemini image extraction with a sample image.
 * Usage:
 *   export GEMINI_API_KEY="your-key"
 *   npx tsx scripts/test-flow.ts /path/to/item.jpg
 */
async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('❌ Please set GEMINI_API_KEY environment variable.');
    process.exit(1);
  }

  const imagePath = process.argv[2];
  if (!imagePath || !fs.existsSync(imagePath)) {
    console.error('❌ Please provide a valid path to an image file:');
    console.error('   npx tsx scripts/test-flow.ts sample.jpg');
    process.exit(1);
  }

  console.log(`🔍 Analyzing image: ${imagePath}...`);
  const imageBuffer = fs.readFileSync(imagePath);
  const base64 = imageBuffer.toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

  const gemini = new GeminiService(apiKey);
  const result = await gemini.analyzeItemImage(base64, mimeType);

  console.log('\n✅ Extraction Successful!\n');
  console.log('🏷️ Title:', result.title);
  console.log('📂 Category Keywords:', result.categoryKeywords);
  console.log('⭐ Condition:', result.condition, `(${result.conditionDescription})`);
  console.log('💰 Suggested Price:', `$${result.suggestedPrice.recommended} (Range: $${result.suggestedPrice.low} - $${result.suggestedPrice.high})`);
  console.log('\n📋 Aspects:', JSON.stringify(result.aspects, null, 2));
  console.log('\n📝 Description HTML:\n', result.descriptionHtml);
}

main().catch((err) => {
  console.error('Error during test:', err);
  process.exit(1);
});
