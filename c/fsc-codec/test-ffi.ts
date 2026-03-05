/**
 * Bun FFI 集成测试 — 验证 TS 绑定与 C codec 的正确性
 * 运行: bun run c/fsc-codec/test-ffi.ts
 */
import { FscCodec } from './ffi-bun';
import { resolve } from 'path';

const LIB_PATH = resolve(import.meta.dir, 'libfsc-ffi.so');

console.log('=== FSC-Codec Bun FFI Test ===\n');

const codec = new FscCodec(LIB_PATH);
console.log(`Version: ${codec.version()}`);

// Test 1: encode + decode result
console.log('\n--- Test 1: TaskResult roundtrip ---');
const result = {
  taskId: 'task-001',
  agentId: 'agent-epyc-sv-01',
  status: 'success',
  qualityScore: 85,
  tokensUsed: 2048,
  costUsd: 0.0032,
  durationMs: 4500,
  timestamp: 1741123456789,
};

const encoded = codec.encodeResult(result);
console.log(`Encoded: ${encoded.length} bytes`);

const decoded = codec.decodeResult(Buffer.from(encoded));
console.log(`Decoded:`, decoded);

console.assert(decoded.taskId === result.taskId, `taskId mismatch: ${decoded.taskId}`);
console.assert(decoded.agentId === result.agentId, `agentId mismatch: ${decoded.agentId}`);
console.assert(decoded.status === result.status, `status mismatch`);
console.assert(decoded.qualityScore === result.qualityScore, `qualityScore mismatch`);
console.assert(decoded.tokensUsed === result.tokensUsed, `tokensUsed mismatch`);
console.assert(Math.abs(decoded.costUsd - result.costUsd) < 0.0001, `costUsd mismatch`);
console.assert(decoded.durationMs === result.durationMs, `durationMs mismatch`);
console.assert(decoded.timestamp === result.timestamp, `timestamp mismatch`);
console.log('PASS');

// Test 2: base64 roundtrip
console.log('\n--- Test 2: Base64 roundtrip ---');
const b64 = codec.toBase64(Buffer.from(encoded));
console.log(`Base64: ${b64.length} chars`);
const fromB64 = codec.decodeResultB64(b64);
console.assert(fromB64.taskId === result.taskId, 'b64 taskId mismatch');
console.assert(fromB64.qualityScore === result.qualityScore, 'b64 qualityScore mismatch');
console.log('PASS');

// Test 3: heartbeat
console.log('\n--- Test 3: Heartbeat roundtrip ---');
const hb = {
  agentId: 'worker-sv-01',
  nodeId: '10.10.0.2',
  cpuPercent: 45.7,
  memUsedMb: 1536,
  memTotalMb: 8192,
  activeTasks: 8,
  timestamp: 1741123456789,
};

const hbEncoded = codec.encodeHeartbeat(hb);
console.log(`Encoded: ${hbEncoded.length} bytes`);

const hbDecoded = codec.decodeHeartbeat(Buffer.from(hbEncoded));
console.log(`Decoded:`, hbDecoded);
console.assert(hbDecoded.agentId === hb.agentId, 'hb agentId mismatch');
console.assert(hbDecoded.memUsedMb === hb.memUsedMb, 'hb memUsedMb mismatch');
console.assert(hbDecoded.activeTasks === hb.activeTasks, 'hb activeTasks mismatch');
console.log('PASS');

// Test 4: with failure_class
console.log('\n--- Test 4: Result with failure_class ---');
const failResult = {
  taskId: 't-42',
  agentId: 'a-1',
  status: 'failure',
  failureClass: 'RESOURCE',
  qualityScore: 30,
  tokensUsed: 500,
  costUsd: 0.001,
  durationMs: 1200,
  timestamp: 1741100000000,
};

const failEncoded = codec.encodeResult(failResult);
const failDecoded = codec.decodeResult(Buffer.from(failEncoded));
console.assert(failDecoded.failureClass === 'RESOURCE', `failureClass mismatch: ${failDecoded.failureClass}`);
console.log('PASS');

codec.destroy();
console.log('\n=== All FFI tests passed! ===');
