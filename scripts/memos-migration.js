#!/usr/bin/env node

/**
 * Memos Migration Script
 * 
 * Fetches memos from Memos API, extracts facts using LLM,
 * and stores them as pointers in Qdrant
 */

const { QdrantPointerStore } = require('../memory/qdrant-pointer');
const { PointerSystem } = require('../memory/pointer');

class MemosMigration {
  constructor(config) {
    this.memosUrl = config.memosUrl;
    this.memosToken = config.memosToken;
    this.openaiKey = config.openaiKey;
    this.qdrantUrl = config.qdrantUrl || 'http://localhost:6333';
    
    this.store = new QdrantPointerStore(this.qdrantUrl);
    this.pointerSystem = new PointerSystem();
  }

  /**
   * Fetch all memos from Memos API
   */
  async fetchMemos() {
    try {
      const response = await fetch(`${this.memosUrl}/api/v1/memos`, {
        headers: {
          'Authorization': `Bearer ${this.memosToken}`
        }
      });

      if (!response.ok) {
        throw new Error(`Memos API error: ${response.status}`);
      }

      const data = await response.json();
      return data.memos || [];
    } catch (error) {
      console.error('Failed to fetch memos:', error);
      throw error;
    }
  }

  /**
   * Extract facts from memo using LLM
   * @param {Object} memo - Memo object
   * @returns {Array<Object>} Extracted facts
   */
  async extractFacts(memo) {
    const prompt = `Extract structured facts from this memo. For each fact, provide:
- domain: category (e.g., 'finance', 'api', 'code', 'personal')
- topic: subcategory (e.g., 'rule', 'auth', 'bug', 'preference')
- slug: short identifier (e.g., 'revenue', 'clientId')
- type: 'fact', 'rule', 'lesson', or 'error'
- content: the fact itself
- keywords: array of relevant keywords

Memo:
${memo.content}

Return JSON array of facts.`;

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [
            { role: 'system', content: 'You are a fact extraction assistant. Return only valid JSON.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3
        })
      });

      const data = await response.json();
      const content = data.choices[0].message.content;
      
      // Parse JSON response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn('No facts extracted from memo:', memo.id);
        return [];
      }

      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('Failed to extract facts:', error);
      return [];
    }
  }

  /**
   * Generate embedding for text
   * @param {string} text - Text to embed
   * @returns {Array<number>} Embedding vector
   */
  async generateEmbedding(text) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openaiKey}`
        },
        body: JSON.stringify({
          model: 'text-embedding-ada-002',
          input: text
        })
      });

      const data = await response.json();
      return data.data[0].embedding;
    } catch (error) {
      console.error('Failed to generate embedding:', error);
      throw error;
    }
  }

  /**
   * Migrate a single memo
   * @param {Object} memo - Memo object
   */
  async migrateMemo(memo) {
    console.log(`Processing memo ${memo.id}...`);

    // Extract facts
    const facts = await this.extractFacts(memo);
    
    if (facts.length === 0) {
      console.log(`  No facts extracted`);
      return;
    }

    console.log(`  Extracted ${facts.length} facts`);

    // Store each fact as a pointer
    for (const fact of facts) {
      try {
        // Generate pointer
        const pointer = this.pointerSystem.generatePointer(
          fact.domain,
          fact.topic,
          fact.slug,
          'v1'
        );

        // Create payload
        const payload = this.pointerSystem.createPayload({
          pointer,
          type: fact.type,
          topic: fact.topic,
          content: fact.content,
          keywords: fact.keywords,
          metadata: {
            source: 'memos',
            memo_id: memo.id,
            created_at: memo.createdAt,
            updated_at: memo.updatedAt
          }
        });

        // Generate embedding
        const embedding = await this.generateEmbedding(fact.content);

        // Store in Qdrant
        await this.store.storePointer(payload, embedding);

        console.log(`  ✓ Stored: ${pointer}`);
      } catch (error) {
        console.error(`  ✗ Failed to store fact:`, error);
      }
    }
  }

  /**
   * Run full migration
   */
  async run() {
    console.log('Starting Memos migration...\n');

    // Initialize Qdrant
    await this.store.initialize();

    // Fetch memos
    console.log('Fetching memos...');
    const memos = await this.fetchMemos();
    console.log(`Found ${memos.length} memos\n`);

    // Migrate each memo
    for (const memo of memos) {
      await this.migrateMemo(memo);
    }

    // Export directory
    console.log('\nExporting pointer directory...');
    const directory = await this.store.exportDirectory();
    
    const fs = require('fs');
    fs.writeFileSync(
      './memory/pointers.json',
      JSON.stringify(directory, null, 2)
    );

    console.log(`✓ Migration complete! ${Object.keys(directory.pointers).length} pointers stored.`);
  }
}

// CLI
if (require.main === module) {
  const config = {
    memosUrl: process.env.MEMOS_URL || 'http://localhost:5230',
    memosToken: process.env.MEMOS_TOKEN,
    openaiKey: process.env.OPENAI_KEY,
    qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333'
  };

  if (!config.memosToken) {
    console.error('Error: MEMOS_TOKEN environment variable required');
    process.exit(1);
  }

  if (!config.openaiKey) {
    console.error('Error: OPENAI_KEY environment variable required');
    process.exit(1);
  }

  const migration = new MemosMigration(config);
  migration.run().catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}

module.exports = { MemosMigration };
