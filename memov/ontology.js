#!/usr/bin/env node
/**
 * MemoV 知识图谱
 * 
 * 功能：
 * - 实体-关系-属性三元组存储
 * - 向量索引与语义搜索
 * - 图谱可视化
 */

const { VectorStore } = require('@langchain/core/vectorstores');
const { MemoryVectorStore } = require('langchain/vectorstores/memory');
const { OpenAIEmbeddings } = require('@langchain/openai');

class Ontology {
  constructor() {
    this.entities = new Map(); // id -> { type, props }
    this.relations = []; // { from, to, type, props }
    this.vectorStore = null;
  }

  /**
   * 添加实体
   * @param {string} id - 实体ID
   * @param {string} type - 实体类型
   * @param {object} props - 实体属性
   */
  addEntity(id, type, props = {}) {
    this.entities.set(id, { type, props, createdAt: Date.now() });
  }

  /**
   * 添加关系
   * @param {string} from - 起点实体ID
   * @param {string} to - 终点实体ID
   * @param {string} type - 关系类型
   * @param {object} props - 关系属性
   */
  addRelation(from, to, type, props = {}) {
    this.relations.push({ from, to, type, props, createdAt: Date.now() });
  }

  /**
   * 初始化向量索引
   */
  async initVectorStore() {
    const texts = [];
    const metadatas = [];

    for (const [id, entity] of this.entities) {
      texts.push(`${entity.type}: ${id} ${JSON.stringify(entity.props)}`);
      metadatas.push({ id, type: 'entity', ...entity });
    }

    for (const rel of this.relations) {
      texts.push(`${rel.from} -> ${rel.to} (${rel.type}) ${JSON.stringify(rel.props)}`);
      metadatas.push({ type: 'relation', ...rel });
    }

    this.vectorStore = await MemoryVectorStore.fromTexts(
      texts,
      metadatas,
      new OpenAIEmbeddings()
    );
  }

  /**
   * 语义搜索
   * @param {string} query - 查询
   * @param {number} k - 返回数量
   */
  async search(query, k = 5) {
    if (!this.vectorStore) await this.initVectorStore();
    return await this.vectorStore.similaritySearch(query, k);
  }

  /**
   * 导出为 JSON
   */
  toJSON() {
    return {
      entities: Object.fromEntries(this.entities),
      relations: this.relations
    };
  }
}

module.exports = { Ontology };
