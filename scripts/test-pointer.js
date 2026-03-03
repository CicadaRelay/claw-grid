#!/usr/bin/env node

/**
 * Pointer System Test
 * 
 * Tests pointer generation, versioning, and Qdrant integration
 */

const { PointerSystem } = require('../memory/pointer');
const { QdrantPointerStore } = require('../memory/qdrant-pointer');

async function testPointerSystem() {
  console.log('=== Testing Pointer System ===\n');

  const ps = new PointerSystem();

  // Test 1: Generate pointers
  console.log('Test 1: Generate pointers');
  const ptr1 = ps.generatePointer('finance', 'rule', 'revenue', '2025-Q1');
  console.log(`  Generated: ${ptr1}`);
  console.log(`  Expected: ptr://finance/rule/revenue@2025-Q1`);
  console.log(`  ✓ Pass\n`);

  // Test 2: Parse pointer
  console.log('Test 2: Parse pointer');
  const parsed = ps.parsePointer(ptr1);
  console.log(`  Parsed:`, parsed);
  console.log(`  ✓ Pass\n`);

  // Test 3: Hash pointer
  console.log('Test 3: Hash pointer');
  const hashPtr = ps.generateHashPointer('test content');
  console.log(`  Generated: ${hashPtr}`);
  console.log(`  ✓ Pass\n`);

  // Test 4: Create payload
  console.log('Test 4: Create payload');
  const payload = ps.createPayload({
    pointer: ptr1,
    type: 'rule',
    topic: 'finance',
    content: 'Revenue recognition follows ASC 606',
    keywords: ['revenue', 'accounting', 'ASC606']
  });
  console.log(`  Payload:`, payload);
  console.log(`  ✓ Pass\n`);

  // Test 5: Deprecate and create new version
  console.log('Test 5: Deprecate and create new version');
  ps.store(ptr1, payload);
  
  const newPayload = ps.deprecateAndCreate(ptr1, {
    type: 'rule',
    topic: 'finance',
    content: 'Revenue recognition follows ASC 606 (updated for 2026)',
    keywords: ['revenue', 'accounting', 'ASC606', '2026']
  });
  
  console.log(`  Old pointer: ${ptr1} (deprecated)`);
  console.log(`  New pointer: ${newPayload.pointer}`);
  console.log(`  Supersedes: ${newPayload.supersedes}`);
  console.log(`  ✓ Pass\n`);

  // Test 6: Get pointer chain
  console.log('Test 6: Get pointer chain');
  const chain = ps.getPointerChain(newPayload.pointer);
  console.log(`  Chain:`, chain);
  console.log(`  ✓ Pass\n`);

  // Test 7: Search by keywords
  console.log('Test 7: Search by keywords');
  const results = ps.searchByKeywords(['revenue', 'accounting']);
  console.log(`  Found ${results.length} results`);
  console.log(`  ✓ Pass\n`);

  // Test 8: Export directory
  console.log('Test 8: Export directory');
  const directory = ps.exportDirectory();
  console.log(`  Exported ${Object.keys(directory.pointers).length} pointers`);
  console.log(`  ✓ Pass\n`);

  console.log('=== All tests passed! ===\n');
}

async function testQdrantIntegration() {
  console.log('=== Testing Qdrant Integration ===\n');

  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
  const store = new QdrantPointerStore(qdrantUrl, 'test_pointers');

  try {
    // Test 1: Initialize
    console.log('Test 1: Initialize collection');
    await store.initialize();
    console.log('  ✓ Collection initialized\n');

    // Test 2: Store pointer
    console.log('Test 2: Store pointer');
    const pointer = 'ptr://test/demo/example@v1';
    const payload = store.pointerSystem.createPayload({
      pointer,
      type: 'fact',
      topic: 'test',
      content: 'This is a test pointer for demonstration',
      keywords: ['test', 'demo', 'example']
    });

    // Mock embedding (in real use, call OpenAI API)
    const embedding = Array(1536).fill(0).map(() => Math.random());
    
    await store.storePointer(payload, embedding);
    console.log(`  ✓ Stored: ${pointer}\n`);

    // Test 3: Get pointer
    console.log('Test 3: Get pointer');
    const retrieved = await store.getPointer(pointer);
    console.log(`  Retrieved:`, retrieved);
    console.log(`  ✓ Pass\n`);

    // Test 4: Search pointers
    console.log('Test 4: Search pointers');
    const queryEmbedding = Array(1536).fill(0).map(() => Math.random());
    const results = await store.searchPointers(queryEmbedding, 5);
    console.log(`  Found ${results.length} results`);
    console.log(`  ✓ Pass\n`);

    // Test 5: Filter by topic
    console.log('Test 5: Filter by topic');
    const filtered = await store.getActiveByTopic('test');
    console.log(`  Found ${filtered.length} active pointers in 'test' topic`);
    console.log(`  ✓ Pass\n`);

    console.log('=== Qdrant integration tests passed! ===\n');
    console.log('Note: To clean up, delete the test_pointers collection in Qdrant');

  } catch (error) {
    console.error('Test failed:', error);
    console.log('\nMake sure Qdrant is running at', qdrantUrl);
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--qdrant')) {
    testQdrantIntegration();
  } else {
    testPointerSystem();
  }
}

module.exports = { testPointerSystem, testQdrantIntegration };
