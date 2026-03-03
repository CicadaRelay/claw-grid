/**
 * Qdrant Pointer Integration
 * 
 * Combines pointer system with Qdrant vector search
 */

const { PointerSystem } = require('./pointer');

class QdrantPointerStore {
  constructor(qdrantUrl = 'http://localhost:6333', collectionName = 'memory_pointers') {
    this.qdrantUrl = qdrantUrl;
    this.collectionName = collectionName;
    this.pointerSystem = new PointerSystem();
  }

  /**
   * Initialize Qdrant collection
   */
  async initialize() {
    try {
      // Check if collection exists
      const response = await fetch(`${this.qdrantUrl}/collections/${this.collectionName}`);
      
      if (response.status === 404) {
        // Create collection
        await fetch(`${this.qdrantUrl}/collections/${this.collectionName}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vectors: {
              size: 1536, // OpenAI embedding size
              distance: 'Cosine'
            }
          })
        });
        console.log(`Created collection: ${this.collectionName}`);
      }
    } catch (error) {
      console.error('Failed to initialize Qdrant:', error);
      throw error;
    }
  }

  /**
   * Store pointer with vector embedding
   * @param {Object} payload - Memory payload
   * @param {Array<number>} embedding - Vector embedding
   */
  async storePointer(payload, embedding) {
    const pointId = this.generatePointId(payload.pointer);
    
    try {
      await fetch(`${this.qdrantUrl}/collections/${this.collectionName}/points`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: [{
            id: pointId,
            vector: embedding,
            payload: {
              ...payload,
              _indexed_at: new Date().toISOString()
            }
          }]
        })
      });

      // Also store in local pointer system
      this.pointerSystem.store(payload.pointer, payload);
      
      return pointId;
    } catch (error) {
      console.error('Failed to store pointer:', error);
      throw error;
    }
  }

  /**
   * Search pointers by vector similarity
   * @param {Array<number>} queryEmbedding - Query vector
   * @param {number} limit - Max results
   * @param {Object} filter - Qdrant filter
   * @returns {Array<Object>} Search results
   */
  async searchPointers(queryEmbedding, limit = 10, filter = null) {
    try {
      const body = {
        vector: queryEmbedding,
        limit,
        with_payload: true,
        with_vector: false
      };

      if (filter) {
        body.filter = filter;
      }

      const response = await fetch(
        `${this.qdrantUrl}/collections/${this.collectionName}/points/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );

      const data = await response.json();
      
      return data.result.map(item => ({
        pointer: item.payload.pointer,
        score: item.score,
        summary: item.payload.content.substring(0, 200),
        payload: item.payload
      }));
    } catch (error) {
      console.error('Failed to search pointers:', error);
      throw error;
    }
  }

  /**
   * Get pointer by exact URI
   * @param {string} pointer - Pointer URI
   * @returns {Object|null} Payload or null
   */
  async getPointer(pointer) {
    // Try local cache first
    const cached = this.pointerSystem.get(pointer);
    if (cached) return cached;

    // Query Qdrant
    try {
      const pointId = this.generatePointId(pointer);
      const response = await fetch(
        `${this.qdrantUrl}/collections/${this.collectionName}/points/${pointId}`
      );

      if (response.status === 404) return null;

      const data = await response.json();
      return data.result.payload;
    } catch (error) {
      console.error('Failed to get pointer:', error);
      return null;
    }
  }

  /**
   * Filter pointers by payload fields
   * @param {Object} filter - Qdrant filter
   * @param {number} limit - Max results
   * @returns {Array<Object>} Filtered results
   */
  async filterPointers(filter, limit = 100) {
    try {
      const response = await fetch(
        `${this.qdrantUrl}/collections/${this.collectionName}/points/scroll`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filter,
            limit,
            with_payload: true,
            with_vector: false
          })
        }
      );

      const data = await response.json();
      return data.result.points.map(p => p.payload);
    } catch (error) {
      console.error('Failed to filter pointers:', error);
      throw error;
    }
  }

  /**
   * Get active pointers by topic
   * @param {string} topic - Topic name
   * @returns {Array<Object>} Active pointers
   */
  async getActiveByTopic(topic) {
    return this.filterPointers({
      must: [
        { key: 'topic', match: { value: topic } },
        { key: 'status', match: { value: 'active' } }
      ]
    });
  }

  /**
   * Get pointer chain (all versions)
   * @param {string} pointer - Any pointer in the chain
   * @returns {Array<Object>} Chain of pointers
   */
  async getPointerChain(pointer) {
    const chain = [];
    let current = pointer;

    while (current) {
      const payload = await this.getPointer(current);
      if (!payload) break;

      chain.push(payload);

      // Find what supersedes this
      const superseding = await this.filterPointers({
        must: [
          { key: 'supersedes', match: { value: current } }
        ]
      }, 1);

      if (superseding.length > 0) {
        current = superseding[0].pointer;
      } else {
        break;
      }
    }

    return chain;
  }

  /**
   * Deprecate pointer and create new version
   * @param {string} oldPointer - Old pointer
   * @param {Object} newPayload - New payload data
   * @param {Array<number>} newEmbedding - New embedding
   * @returns {Object} New payload
   */
  async deprecateAndCreate(oldPointer, newPayload, newEmbedding) {
    // Get old payload
    const oldPayload = await this.getPointer(oldPointer);
    if (!oldPayload) {
      throw new Error(`Pointer not found: ${oldPointer}`);
    }

    // Mark as deprecated
    oldPayload.status = 'deprecated';
    oldPayload.updated_at = new Date().toISOString();

    // Update in Qdrant
    const oldPointId = this.generatePointId(oldPointer);
    await fetch(
      `${this.qdrantUrl}/collections/${this.collectionName}/points/payload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points: [oldPointId],
          payload: {
            status: 'deprecated',
            updated_at: oldPayload.updated_at
          }
        })
      }
    );

    // Create new version
    const parsed = this.pointerSystem.parsePointer(oldPointer);
    const newVersion = this.pointerSystem.incrementVersion(parsed.version);
    const newPointer = this.pointerSystem.generatePointer(
      parsed.domain,
      parsed.topic,
      parsed.slug,
      newVersion
    );

    const fullPayload = this.pointerSystem.createPayload({
      ...newPayload,
      pointer: newPointer,
      version: newVersion,
      supersedes: oldPointer
    });

    await this.storePointer(fullPayload, newEmbedding);

    return fullPayload;
  }

  /**
   * Generate point ID from pointer
   * @param {string} pointer - Pointer URI
   * @returns {number} Point ID
   */
  generatePointId(pointer) {
    // Use hash of pointer as numeric ID
    let hash = 0;
    for (let i = 0; i < pointer.length; i++) {
      hash = ((hash << 5) - hash) + pointer.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Export all pointers to directory
   * @returns {Object} Pointers directory
   */
  async exportDirectory() {
    const allPointers = await this.filterPointers({}, 10000);
    
    const directory = {
      version: '1.0',
      updated_at: new Date().toISOString(),
      pointers: {}
    };

    for (const payload of allPointers) {
      directory.pointers[payload.pointer] = payload;
    }

    return directory;
  }

  /**
   * Import directory to Qdrant
   * @param {Object} directory - Pointers directory
   * @param {Function} embedFn - Function to generate embeddings
   */
  async importDirectory(directory, embedFn) {
    if (!directory.pointers) {
      throw new Error('Invalid directory format');
    }

    const pointers = Object.values(directory.pointers);
    console.log(`Importing ${pointers.length} pointers...`);

    for (const payload of pointers) {
      const embedding = await embedFn(payload.content);
      await this.storePointer(payload, embedding);
    }

    console.log('Import complete');
  }
}

module.exports = { QdrantPointerStore };
