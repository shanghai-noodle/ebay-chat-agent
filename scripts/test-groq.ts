import fs from 'node:fs';
import path from 'node:path';
import { getAIService } from '../src/services/ai/factory';

async function main() {
  const envContent = fs.readFileSync(path.resolve(__dirname, '../.dev.vars'), 'utf8');
  const env: Record<string, string> = {};
  for (const line of envContent.split('\n')) {
    if (line.includes('=')) {
      const idx = line.indexOf('=');
      env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    }
  }

  const ai = getAIService(env as any);
  console.log(`🚀 Initialized AI Provider: ${ai.providerName}`);

  // 1. Test Chat
  console.log('\n--- 1. Testing chatWithSeller ---');
  const chatRes = await ai.chatWithSeller('What are your top recommendations for selling Transformers on eBay?');
  console.log('Chat Reply:\n', chatRes.replyText);

  // 2. Test Image Extraction
  console.log('\n--- 2. Testing analyzeItemImage ---');
  const imgPath = '/Users/guw/.gemini/antigravity/brain/640c9db3-3fb3-4fc0-aed0-7f40b4a089d1/ebay_logo_simple_1791085096096.jpg';
  const imgBuf = fs.readFileSync(imgPath);
  const base64 = imgBuf.toString('base64');
  const analysis = await ai.analyzeItemImage(base64, 'image/jpeg');

  console.log('✅ Extracted Title:', analysis.title);
  console.log('💰 Suggested Price:', analysis.suggestedPrice);
  console.log('⭐ Condition:', analysis.condition);
  console.log('🏷️ Aspects:', Object.keys(analysis.aspects));
  console.log('📊 Market Intelligence:', analysis.marketIntelligence);

  // 3. Test Refine Listing
  console.log('\n--- 3. Testing refineListing ---');
  const draftUpdate = await ai.refineListing(
    {
      id: 'test_123',
      spaceId: 'space_1',
      status: 'READY_TO_PUBLISH',
      title: analysis.title,
      price: analysis.suggestedPrice.recommended,
      shippingCost: 0,
      currency: 'USD',
      condition: analysis.condition,
      conditionDescription: analysis.conditionDescription,
      aspects: analysis.aspects,
      descriptionHtml: analysis.descriptionHtml,
      categoryId: '1',
      categoryName: 'Test',
      imageUrls: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      quantity: 1,
    },
    'Please change price to $39.99 and set shipping to $4.50'
  );
  console.log('Refined Fields:', draftUpdate);

  console.log('\n🎉 ALL GROQ FREE TIER TESTS PASSED SUCCESSFULLY!');
}

main().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
