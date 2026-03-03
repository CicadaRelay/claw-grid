#!/usr/bin/env node
/**
 * MemoV 知识图谱初始化
 * 
 * 功能：
 * - 初始化本体结构
 * - 加载默认实体和关系
 * - 构建初始向量索引
 */

const { Ontology } = require('./ontology');
const { CausalAnalyzer } = require('./causal');

async function initOntology() {
  console.log('🔧 初始化 MemoV 知识图谱...');

  const ontology = new Ontology();
  const causal = new CausalAnalyzer();

  // ============ 1. 添加核心实体 ============
  console.log('📦 添加核心实体...');

  // 节点实体
  ontology.addEntity('central', 'Node', {
    name: '中央节点',
    ip: '10.10.0.1',
    role: 'gateway',
    status: 'online'
  });

  ontology.addEntity('silicon-valley', 'Node', {
    name: '硅谷节点',
    ip: '10.10.0.2',
    role: 'worker-heavy',
    status: 'online'
  });

  ontology.addEntity('tokyo', 'Node', {
    name: '东京节点',
    ip: '10.10.0.3',
    role: 'worker-light',
    status: 'online'
  });

  ontology.addEntity('curryclaw', 'Node', {
    name: 'CURRYCLAW',
    ip: '10.10.0.4',
    role: 'edge',
    status: 'online'
  });

  // 系统实体
  ontology.addEntity('fsc-gateway', 'System', {
    name: 'FSC Gateway Daemon',
    version: '1.0.0',
    status: 'running'
  });

  ontology.addEntity('fsc-worker', 'System', {
    name: 'FSC Worker Daemon',
    version: '1.0.0',
    status: 'running'
  });

  ontology.addEntity('memov', 'System', {
    name: 'MemoV',
    version: '1.0.0',
    status: 'initializing'
  });

  // ============ 2. 添加关系 ============
  console.log('🔗 添加关系...');

  // 节点间关系
  ontology.addRelation('central', 'silicon-valley', 'CONNECTS_TO', {
    protocol: 'WireGuard',
    latency: '107ms',
    status: 'healthy'
  });

  ontology.addRelation('central', 'tokyo', 'CONNECTS_TO', {
    protocol: 'WireGuard',
    latency: '3ms',
    status: 'healthy'
  });

  ontology.addRelation('central', 'curryclaw', 'CONNECTS_TO', {
    protocol: 'WireGuard',
    latency: '20ms',
    status: 'healthy'
  });

  // 系统-节点关系
  ontology.addRelation('fsc-gateway', 'central', 'RUNS_ON', {});
  ontology.addRelation('fsc-worker', 'silicon-valley', 'RUNS_ON', {});
  ontology.addRelation('fsc-worker', 'tokyo', 'RUNS_ON', {});
  ontology.addRelation('memov', 'central', 'RUNS_ON', {});

  // ============ 3. 初始化向量索引 ============
  console.log('📊 初始化向量索引...');
  await ontology.initVectorStore();

  // ============ 4. 导出 ============
  console.log('💾 保存知识图谱...');
  const fs = require('fs');
  const path = require('path');

  const outputPath = path.join(__dirname, 'ontology.json');
  fs.writeFileSync(outputPath, JSON.stringify(ontology.toJSON(), null, 2));

  console.log('✅ MemoV 知识图谱初始化完成！');
  console.log(`   实体数: ${ontology.entities.size}`);
  console.log(`   关系数: ${ontology.relations.length}`);
  console.log(`   输出文件: ${outputPath}`);

  return { ontology, causal };
}

// 直接运行时执行
if (require.main === module) {
  initOntology().catch(console.error);
}

module.exports = { initOntology };
