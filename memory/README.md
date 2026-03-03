# Pointer Memory System

URI-based memory addressing with versioning, causal tracking, and vector search.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Pointer Memory OS                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Pointer    │───▶│   Qdrant     │───▶│    MemoV     │  │
│  │   System     │    │   Vector     │    │   Git Sync   │  │
│  │              │    │   Search     │    │              │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                    │                    │          │
│         ▼                    ▼                    ▼          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Pointer Directory (JSON)                 │  │
│  │  ptr://domain/topic/slug@version → payload           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

## Pointer Format

```
ptr://{domain}/{topic}/{slug}@{version}
```

**Examples:**
- `ptr://finance/rule/revenue@2025-Q1`
- `ptr://api/auth/clientId@v2`
- `ptr://code/bug/memory-leak@v1`
- `ptr://hash/sha256:a1b2c3d4e5f6` (content-addressed)

## Components

### 1. Pointer System (`memory/pointer.js`)

Core pointer generation, versioning, and management.

```javascript
const { PointerSystem } = require('./memory/pointer');

const ps = new PointerSystem();

// Generate pointer
const ptr = ps.generatePointer('finance', 'rule', 'revenue', 'v1');
// → ptr://finance/rule/revenue@v1

// Create payload
const payload = ps.createPayload({
  pointer: ptr,
  type: 'rule',
  topic: 'finance',
  content: 'Revenue recognition follows ASC 606',
  keywords: ['revenue', 'accounting']
});

// Store
ps.store(ptr, payload);

// Deprecate and create new version
const newPayload = ps.deprecateAndCreate(ptr, {
  type: 'rule',
  topic: 'finance',
  content: 'Updated revenue rule for 2026',
  keywords: ['revenue', 'accounting', '2026']
});
// → ptr://finance/rule/revenue@v2 (supersedes v1)
```

### 2. Qdrant Integration (`memory/qdrant-pointer.js`)

Vector search with pointer addressing.

```javascript
const { QdrantPointerStore } = require('./memory/qdrant-pointer');

const store = new QdrantPointerStore('http://localhost:6333');

// Initialize
await store.initialize();

// Store with embedding
await store.storePointer(payload, embedding);

// Search by vector similarity
const results = await store.searchPointers(queryEmbedding, 10);
// → [{ pointer, score, summary, payload }]

// Get exact pointer
const payload = await store.getPointer('ptr://finance/rule/revenue@v1');

// Filter by topic
const active = await store.getActiveByTopic('finance');

// Get version chain
const chain = await store.getPointerChain('ptr://finance/rule/revenue@v2');
// → [v1, v2]
```

### 3. Memos Migration (`scripts/memos-migration.js`)

Migrate existing Memos to pointer system.

```bash
# Set environment variables
export MEMOS_URL=http://localhost:5230
export MEMOS_TOKEN=your_token
export OPENAI_KEY=sk-...
export QDRANT_URL=http://localhost:6333

# Run migration
node scripts/memos-migration.js
```

**Process:**
1. Fetch all memos from Memos API
2. Extract facts using GPT-4
3. Generate pointers for each fact
4. Create embeddings with OpenAI
5. Store in Qdrant
6. Export to `memory/pointers.json`

## Payload Structure

```json
{
  "pointer": "ptr://finance/rule/revenue@v1",
  "type": "fact|rule|lesson|error",
  "topic": "finance",
  "content": "Revenue recognition follows ASC 606",
  "version": "v1",
  "status": "active|deprecated",
  "keywords": ["revenue", "accounting"],
  "supersedes": "ptr://finance/rule/revenue@v0",
  "metadata": {
    "source": "memos",
    "memo_id": "123"
  },
  "created_at": "2026-03-03T08:00:00Z",
  "updated_at": "2026-03-03T08:00:00Z"
}
```

## Versioning & Causal Tracking

### Deprecation Flow

```javascript
// Old pointer becomes deprecated
const oldPtr = 'ptr://api/auth/token@v1';
const oldPayload = await store.getPointer(oldPtr);
// status: 'active'

// Create new version
const newPayload = await store.deprecateAndCreate(
  oldPtr,
  { content: 'Updated token logic', ... },
  newEmbedding
);
// → ptr://api/auth/token@v2

// Old pointer now deprecated
const updated = await store.getPointer(oldPtr);
// status: 'deprecated'
// supersedes: null

// New pointer supersedes old
newPayload.supersedes === oldPtr; // true
```

### Version Chain

```javascript
const chain = await store.getPointerChain('ptr://api/auth/token@v3');
// → [
//   { pointer: 'ptr://api/auth/token@v1', status: 'deprecated' },
//   { pointer: 'ptr://api/auth/token@v2', status: 'deprecated' },
//   { pointer: 'ptr://api/auth/token@v3', status: 'active' }
// ]
```

## Testing

```bash
# Test pointer system (no dependencies)
node scripts/test-pointer.js

# Test Qdrant integration (requires Qdrant running)
node scripts/test-pointer.js --qdrant
```

## Integration with claw-mesh

### Directory Structure

```
claw-mesh-dev/
├── memory/
│   ├── pointer.js           # Pointer system
│   ├── qdrant-pointer.js    # Qdrant integration
│   ├── causal.js            # Causal correction (existing)
│   ├── ontology.js          # Ontology (existing)
│   └── pointers.json        # Pointer directory
├── scripts/
│   ├── memos-migration.js   # Memos → Pointers
│   └── test-pointer.js      # Tests
└── .mem/                    # MemoV Git repo
```

### MemoV Fusion (Day 3)

```javascript
// Store in both MemoV and Qdrant
async function fusedStore(text) {
  // 1. Store in MemoV Git
  await memov.store(text);
  
  // 2. Extract pointer
  const pointer = extractPointer(text);
  
  // 3. Generate embedding
  const embedding = await generateEmbedding(text);
  
  // 4. Store in Qdrant
  await store.storePointer(pointer, embedding);
}

// Global recall
async function globalRecall(query) {
  // 1. Search Qdrant
  const embedding = await generateEmbedding(query);
  const results = await store.searchPointers(embedding);
  
  // 2. Get full content from MemoV
  const fullContent = await Promise.all(
    results.map(r => memov.get(r.pointer))
  );
  
  return fullContent;
}
```

## Qdrant Filters

```javascript
// Get active pointers by type
await store.filterPointers({
  must: [
    { key: 'type', match: { value: 'rule' } },
    { key: 'status', match: { value: 'active' } }
  ]
});

// Get pointers by keyword
await store.filterPointers({
  must: [
    { key: 'keywords', match: { any: ['revenue', 'accounting'] } }
  ]
});

// Get recent pointers
await store.filterPointers({
  must: [
    { 
      key: 'created_at', 
      range: { 
        gte: '2026-03-01T00:00:00Z' 
      } 
    }
  ]
});
```

## Environment Variables

```bash
# Qdrant
QDRANT_URL=http://localhost:6333

# OpenAI (for embeddings and extraction)
OPENAI_KEY=sk-...

# Memos (for migration)
MEMOS_URL=http://localhost:5230
MEMOS_TOKEN=your_token

# MemoV
MEMOV_PATH=~/.mem
```

## Next Steps (Day 2-3)

### Day 2: Causal + Tree + A2A
- [ ] Integrate `causal.js` for error correction
- [ ] Add context tree pruning
- [ ] Create A2A agent chain (planner/researcher/coder/validator/updater)

### Day 3: MemoV Fusion + Evolver
- [ ] Implement `fusedStore` and `globalRecall`
- [ ] Add evolver fitness optimization
- [ ] Docker compose setup
- [ ] Distributed sync via claw-mesh

## References

- [memory-qdrant](https://github.com/oadank/memory-qdrant) - Core inspiration
- [memov](https://github.com/memovai/memov) - Code memory
- [claw-mesh](https://github.com/2233admin/claw-mesh) - Distributed mesh
- [Paper 2509: URI-based Memory](https://arxiv.org/abs/2509.xxxxx)
- [Paper 2511: Causal Correction](https://arxiv.org/abs/2511.xxxxx)
