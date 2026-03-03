/**
 * Pointer Memory System
 * 
 * URI-based memory addressing with versioning and causal tracking
 * Format: ptr://{domain}/{topic}/{slug}@{version}
 */

const crypto = require('crypto');

class PointerSystem {
  constructor() {
    this.pointers = new Map();
  }

  /**
   * Generate pointer URI
   * @param {string} domain - Domain (e.g., 'finance', 'api', 'code')
   * @param {string} topic - Topic (e.g., 'rule', 'auth', 'bug')
   * @param {string} slug - Slug (e.g., 'revenue', 'clientId')
   * @param {string} version - Version (e.g., 'v1', '2025-Q1')
   * @returns {string} Pointer URI
   */
  generatePointer(domain, topic, slug, version = 'v1') {
    return `ptr://${domain}/${topic}/${slug}@${version}`;
  }

  /**
   * Generate hash-based pointer
   * @param {string} content - Content to hash
   * @returns {string} Hash pointer
   */
  generateHashPointer(content) {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return `ptr://hash/sha256:${hash.substring(0, 12)}`;
  }

  /**
   * Parse pointer URI
   * @param {string} pointer - Pointer URI
   * @returns {Object} Parsed components
   */
  parsePointer(pointer) {
    const match = pointer.match(/^ptr:\/\/([^\/]+)\/([^\/]+)\/([^@]+)@(.+)$/);
    if (!match) {
      throw new Error(`Invalid pointer format: ${pointer}`);
    }
    return {
      domain: match[1],
      topic: match[2],
      slug: match[3],
      version: match[4]
    };
  }

  /**
   * Create memory payload
   * @param {Object} params - Payload parameters
   * @returns {Object} Memory payload
   */
  createPayload({
    pointer,
    type = 'fact',
    topic,
    content,
    version = 'v1',
    status = 'active',
    keywords = [],
    supersedes = null,
    metadata = {}
  }) {
    return {
      pointer,
      type,
      topic,
      content,
      version,
      status,
      keywords,
      supersedes,
      metadata,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  /**
   * Deprecate old pointer and create new version
   * @param {string} oldPointer - Old pointer to deprecate
   * @param {Object} newPayload - New payload data
   * @returns {Object} New payload with supersedes link
   */
  deprecateAndCreate(oldPointer, newPayload) {
    // Mark old pointer as deprecated
    const oldPayload = this.pointers.get(oldPointer);
    if (oldPayload) {
      oldPayload.status = 'deprecated';
      oldPayload.updated_at = new Date().toISOString();
    }

    // Create new pointer with supersedes link
    const parsed = this.parsePointer(oldPointer);
    const newVersion = this.incrementVersion(parsed.version);
    const newPointer = this.generatePointer(
      parsed.domain,
      parsed.topic,
      parsed.slug,
      newVersion
    );

    const payload = this.createPayload({
      ...newPayload,
      pointer: newPointer,
      version: newVersion,
      supersedes: oldPointer
    });

    this.pointers.set(newPointer, payload);
    return payload;
  }

  /**
   * Increment version string
   * @param {string} version - Current version
   * @returns {string} Next version
   */
  incrementVersion(version) {
    if (version.startsWith('v')) {
      const num = parseInt(version.substring(1));
      return `v${num + 1}`;
    }
    // For date-based versions, append revision
    return `${version}.1`;
  }

  /**
   * Get pointer chain (all versions)
   * @param {string} pointer - Any pointer in the chain
   * @returns {Array} Array of pointers in chronological order
   */
  getPointerChain(pointer) {
    const chain = [];
    let current = pointer;

    // Walk backwards to find the root
    while (current) {
      const payload = this.pointers.get(current);
      if (!payload) break;
      chain.unshift(current);
      
      // Find what this supersedes
      for (const [ptr, p] of this.pointers.entries()) {
        if (p.supersedes === current) {
          current = ptr;
          break;
        }
      }
      if (chain[chain.length - 1] === current) break;
    }

    return chain;
  }

  /**
   * Get active pointer (latest non-deprecated version)
   * @param {string} basePointer - Base pointer (without version)
   * @returns {string|null} Active pointer or null
   */
  getActivePointer(basePointer) {
    const parsed = this.parsePointer(basePointer);
    const prefix = `ptr://${parsed.domain}/${parsed.topic}/${parsed.slug}@`;

    let latestVersion = null;
    let latestPointer = null;

    for (const [ptr, payload] of this.pointers.entries()) {
      if (ptr.startsWith(prefix) && payload.status === 'active') {
        if (!latestVersion || this.compareVersions(payload.version, latestVersion) > 0) {
          latestVersion = payload.version;
          latestPointer = ptr;
        }
      }
    }

    return latestPointer;
  }

  /**
   * Compare version strings
   * @param {string} v1 - Version 1
   * @param {string} v2 - Version 2
   * @returns {number} -1, 0, or 1
   */
  compareVersions(v1, v2) {
    if (v1 === v2) return 0;
    
    // Simple numeric comparison for v1, v2, etc.
    if (v1.startsWith('v') && v2.startsWith('v')) {
      const n1 = parseInt(v1.substring(1));
      const n2 = parseInt(v2.substring(1));
      return n1 - n2;
    }

    // Lexicographic comparison for other formats
    return v1.localeCompare(v2);
  }

  /**
   * Store pointer
   * @param {string} pointer - Pointer URI
   * @param {Object} payload - Memory payload
   */
  store(pointer, payload) {
    this.pointers.set(pointer, payload);
  }

  /**
   * Get pointer payload
   * @param {string} pointer - Pointer URI
   * @returns {Object|null} Payload or null
   */
  get(pointer) {
    return this.pointers.get(pointer) || null;
  }

  /**
   * Search pointers by keywords
   * @param {Array<string>} keywords - Keywords to search
   * @returns {Array<Object>} Matching payloads
   */
  searchByKeywords(keywords) {
    const results = [];
    for (const [ptr, payload] of this.pointers.entries()) {
      if (payload.status !== 'active') continue;
      
      const matches = keywords.some(kw => 
        payload.keywords.includes(kw) ||
        payload.topic.includes(kw) ||
        payload.content.toLowerCase().includes(kw.toLowerCase())
      );

      if (matches) {
        results.push({ pointer: ptr, ...payload });
      }
    }
    return results;
  }

  /**
   * Export pointers to JSON
   * @returns {Object} Pointers directory
   */
  exportDirectory() {
    const directory = {
      version: '1.0',
      updated_at: new Date().toISOString(),
      pointers: {}
    };

    for (const [ptr, payload] of this.pointers.entries()) {
      directory.pointers[ptr] = payload;
    }

    return directory;
  }

  /**
   * Import pointers from JSON
   * @param {Object} directory - Pointers directory
   */
  importDirectory(directory) {
    if (!directory.pointers) {
      throw new Error('Invalid directory format');
    }

    for (const [ptr, payload] of Object.entries(directory.pointers)) {
      this.pointers.set(ptr, payload);
    }
  }
}

module.exports = { PointerSystem };
