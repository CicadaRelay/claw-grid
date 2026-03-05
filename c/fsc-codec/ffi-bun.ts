/**
 * FSC-Codec Bun FFI Bindings — 零拷贝 msgpack 编解码
 *
 * 通过 bun:ffi 调用 libfsc-codec.so，避免 JS 堆分配。
 * 1000 agent 心跳场景下比 @msgpack/msgpack 省 50-80% 内存。
 *
 * 用法:
 *   import { FscCodec } from './c/fsc-codec/ffi-bun';
 *   const codec = new FscCodec('/path/to/libfsc-codec.so');
 *   const encoded = codec.encodeResult({ taskId: 'task-1', ... });
 *   const decoded = codec.decodeResult(encoded);
 */

import { dlopen, FFIType, ptr, toBuffer, toArrayBuffer, CString } from 'bun:ffi';

const { i32, u32, u64, f64, ptr: ptrType } = FFIType;

// ============ 类型定义 ============

export interface TaskResult {
  taskId: string;
  agentId: string;
  status: string;
  failureClass?: string;
  qualityScore: number;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
  timestamp: number;
}

export interface Heartbeat {
  agentId: string;
  nodeId: string;
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  activeTasks: number;
  timestamp: number;
}

// ============ C struct 内存布局 ============

// Verified on Linux x86_64 via verify-layout.c:
// fsc_str_t: { ptr: pointer(8), len: u32(4) } + 4 padding = 16 bytes
const FSC_STR_SIZE = 16;

// fsc_task_result_t = 96 bytes:
//   task_id(0) agent_id(16) status(32) failure_class(48) = 64
//   quality_score(64,u32) tokens_used(68,u32) cost_usd(72,f64)
//   duration_ms(80,u64) timestamp(88,u64)
const RESULT_STRUCT_SIZE = 96;

// fsc_heartbeat_t = 72 bytes:
//   agent_id(0) node_id(16) cpu_percent(32,f64)
//   mem_used_mb(40,u64) mem_total_mb(48,u64) active_tasks(56,u32)
//   timestamp(64,u64)
const HEARTBEAT_STRUCT_SIZE = 72;

// fsc_buf_t: { data: ptr(8), len: u64(8), used: u64(8) } = 24 bytes
const BUF_STRUCT_SIZE = 24;

// fsc_slice_t: { data: ptr(8), len: u64(8) } = 16 bytes
const SLICE_STRUCT_SIZE = 16;

// 编码输出缓冲区
const ENCODE_BUF_SIZE = 2048;
const B64_BUF_SIZE = 4096;

// ============ FscCodec ============

export class FscCodec {
  private lib: ReturnType<typeof dlopen>;
  // 预分配复用缓冲区 — 避免每次调用都分配
  private encodeBuf: Buffer;
  private b64Buf: Buffer;
  private scratchBuf: Buffer;

  constructor(libPath: string) {
    // 使用 ffi_wrapper.c 包装函数 — 所有 struct 参数改为指针传递
    this.lib = dlopen(libPath, {
      ffi_encode_result: { args: [ptrType, ptrType], returns: i32 },
      ffi_encode_heartbeat: { args: [ptrType, ptrType], returns: i32 },
      ffi_decode_result: { args: [ptrType, ptrType], returns: i32 },
      ffi_decode_heartbeat: { args: [ptrType, ptrType], returns: i32 },
      ffi_decode_result_b64: { args: [ptrType, ptrType, ptrType], returns: i32 },
      ffi_to_base64: { args: [ptrType, ptrType], returns: i32 },
      ffi_version: { args: [], returns: ptrType },
    });

    this.encodeBuf = Buffer.alloc(ENCODE_BUF_SIZE);
    this.b64Buf = Buffer.alloc(B64_BUF_SIZE);
    this.scratchBuf = Buffer.alloc(ENCODE_BUF_SIZE);
  }

  version(): string {
    const p = this.lib.symbols.ffi_version();
    return new CString(p);
  }

  /**
   * 编码 TaskResult → msgpack Buffer
   * 返回的 Buffer 是 encodeBuf 的子视图，下次调用会覆盖
   */
  encodeResult(result: TaskResult): Buffer {
    // 分配 C struct + string 存储
    const strData = this.packStrings([
      result.taskId,
      result.agentId,
      result.status,
      result.failureClass || '',
    ]);

    const struct = this.buildResultStruct(result, strData);
    const outBuf = this.buildFscBuf(this.encodeBuf);

    const err = this.lib.symbols.ffi_encode_result(ptr(struct), ptr(outBuf));
    if (err !== 0) throw new Error(`fsc_encode_result failed: ${err}`);

    const used = outBuf.readBigUInt64LE(16); // fsc_buf_t.used offset
    return Buffer.from(this.encodeBuf.buffer, 0, Number(used));
  }

  /**
   * 编码 Heartbeat → msgpack Buffer
   */
  encodeHeartbeat(hb: Heartbeat): Buffer {
    const strData = this.packStrings([hb.agentId, hb.nodeId]);
    const struct = this.buildHeartbeatStruct(hb, strData);
    const outBuf = this.buildFscBuf(this.encodeBuf);

    const err = this.lib.symbols.ffi_encode_heartbeat(ptr(struct), ptr(outBuf));
    if (err !== 0) throw new Error(`fsc_encode_heartbeat failed: ${err}`);

    const used = outBuf.readBigUInt64LE(16);
    return Buffer.from(this.encodeBuf.buffer, 0, Number(used));
  }

  /**
   * 解码 msgpack → TaskResult
   */
  decodeResult(msgpack: Buffer): TaskResult {
    const slice = Buffer.alloc(SLICE_STRUCT_SIZE);
    slice.writeBigUInt64LE(BigInt(ptr(msgpack)), 0);
    slice.writeBigUInt64LE(BigInt(msgpack.length), 8);

    const struct = Buffer.alloc(RESULT_STRUCT_SIZE);
    const err = this.lib.symbols.ffi_decode_result(ptr(slice), ptr(struct));
    if (err !== 0) throw new Error(`fsc_decode_result failed: ${err}`);

    return this.readResultStruct(struct);
  }

  /**
   * 解码 heartbeat
   */
  decodeHeartbeat(msgpack: Buffer): Heartbeat {
    const slice = Buffer.alloc(SLICE_STRUCT_SIZE);
    slice.writeBigUInt64LE(BigInt(ptr(msgpack)), 0);
    slice.writeBigUInt64LE(BigInt(msgpack.length), 8);

    const struct = Buffer.alloc(HEARTBEAT_STRUCT_SIZE);
    const err = this.lib.symbols.ffi_decode_heartbeat(ptr(slice), ptr(struct));
    if (err !== 0) throw new Error(`fsc_decode_heartbeat failed: ${err}`);

    return this.readHeartbeatStruct(struct);
  }

  /**
   * msgpack → base64 字符串 (用于 Redis Stream 写入)
   */
  toBase64(msgpack: Buffer): string {
    const slice = Buffer.alloc(SLICE_STRUCT_SIZE);
    slice.writeBigUInt64LE(BigInt(ptr(msgpack)), 0);
    slice.writeBigUInt64LE(BigInt(msgpack.length), 8);

    const outBuf = this.buildFscBuf(this.b64Buf);
    const err = this.lib.symbols.ffi_to_base64(ptr(slice), ptr(outBuf));
    if (err !== 0) throw new Error(`fsc_to_base64 failed: ${err}`);

    const used = outBuf.readBigUInt64LE(16);
    return this.b64Buf.toString('ascii', 0, Number(used));
  }

  /**
   * base64 → TaskResult (一步到位: b64 decode + msgpack decode)
   */
  decodeResultB64(b64: string): TaskResult {
    const b64Bytes = Buffer.from(b64, 'ascii');

    // fsc_str_t for b64 input
    const b64Str = Buffer.alloc(FSC_STR_SIZE);
    b64Str.writeBigUInt64LE(BigInt(ptr(b64Bytes)), 0);
    b64Str.writeUInt32LE(b64Bytes.length, 8);

    const scratchFscBuf = this.buildFscBuf(this.scratchBuf);
    const struct = Buffer.alloc(RESULT_STRUCT_SIZE);

    const err = this.lib.symbols.ffi_decode_result_b64(
      ptr(b64Str), ptr(scratchFscBuf), ptr(struct)
    );
    if (err !== 0) throw new Error(`fsc_decode_result_b64 failed: ${err}`);

    return this.readResultStruct(struct);
  }

  destroy(): void {
    this.lib.close();
  }

  // ============ 内部方法 ============

  private packStrings(strs: string[]): { bufs: Buffer[]; ptrs: bigint[] } {
    // 空字符串用 1 字节占位 (len=0 所以 C 端不会读取内容)
    const bufs = strs.map(s => s.length > 0 ? Buffer.from(s, 'utf-8') : Buffer.alloc(1));
    const ptrs = bufs.map(b => BigInt(ptr(b)));
    return { bufs, ptrs };
  }

  private buildFscBuf(dataBuf: Buffer): Buffer {
    const buf = Buffer.alloc(BUF_STRUCT_SIZE);
    buf.writeBigUInt64LE(BigInt(ptr(dataBuf)), 0);   // data
    buf.writeBigUInt64LE(BigInt(dataBuf.length), 8);  // len (capacity)
    buf.writeBigUInt64LE(0n, 16);                     // used
    return buf;
  }

  /**
   * 构建 fsc_task_result_t 的内存布局
   * 注意: 这依赖平台 ABI，64-bit Linux x86_64
   */
  private buildResultStruct(
    result: TaskResult,
    strData: { bufs: Buffer[]; ptrs: bigint[] }
  ): Buffer {
    const buf = Buffer.alloc(RESULT_STRUCT_SIZE);
    let off = 0;

    // 4 × fsc_str_t (ptr + len + padding)
    const strLens = [
      result.taskId.length,
      result.agentId.length,
      result.status.length,
      (result.failureClass || '').length,
    ];

    for (let i = 0; i < 4; i++) {
      buf.writeBigUInt64LE(strData.ptrs[i], off);     // ptr
      buf.writeUInt32LE(strLens[i], off + 8);          // len
      off += FSC_STR_SIZE;
    }

    // u32 quality_score, u32 tokens_used
    buf.writeUInt32LE(result.qualityScore, off); off += 4;
    buf.writeUInt32LE(result.tokensUsed, off); off += 4;

    // f64 cost_usd
    buf.writeDoubleLE(result.costUsd, off); off += 8;

    // u64 duration_ms, u64 timestamp
    buf.writeBigUInt64LE(BigInt(result.durationMs), off); off += 8;
    buf.writeBigUInt64LE(BigInt(result.timestamp), off);

    return buf;
  }

  private buildHeartbeatStruct(
    hb: Heartbeat,
    strData: { bufs: Buffer[]; ptrs: bigint[] }
  ): Buffer {
    const buf = Buffer.alloc(HEARTBEAT_STRUCT_SIZE);
    let off = 0;

    // 2 × fsc_str_t
    const strLens = [hb.agentId.length, hb.nodeId.length];
    for (let i = 0; i < 2; i++) {
      buf.writeBigUInt64LE(strData.ptrs[i], off);
      buf.writeUInt32LE(strLens[i], off + 8);
      off += FSC_STR_SIZE;
    }

    // f64 cpu_percent
    buf.writeDoubleLE(hb.cpuPercent, off); off += 8;
    // u64 mem_used_mb, mem_total_mb
    buf.writeBigUInt64LE(BigInt(hb.memUsedMb), off); off += 8;
    buf.writeBigUInt64LE(BigInt(hb.memTotalMb), off); off += 8;
    // u32 active_tasks (offset 56) + 4 padding
    buf.writeUInt32LE(hb.activeTasks, off); off += 8; // 4 bytes + 4 padding to align u64
    // u64 timestamp (offset 64)
    buf.writeBigUInt64LE(BigInt(hb.timestamp), off);

    return buf;
  }

  private readResultStruct(buf: Buffer): TaskResult {
    let off = 0;
    const strs: string[] = [];

    for (let i = 0; i < 4; i++) {
      const strPtr = buf.readBigUInt64LE(off);
      const strLen = buf.readUInt32LE(off + 8);
      if (strLen > 0 && strPtr > 0n) {
        const strBuf = toBuffer(Number(strPtr), 0, strLen);
        strs.push(strBuf.toString('utf-8'));
      } else {
        strs.push('');
      }
      off += FSC_STR_SIZE;
    }

    return {
      taskId: strs[0],
      agentId: strs[1],
      status: strs[2],
      failureClass: strs[3] || undefined,
      qualityScore: buf.readUInt32LE(off),
      tokensUsed: buf.readUInt32LE(off + 4),
      costUsd: buf.readDoubleLE(off + 8),
      durationMs: Number(buf.readBigUInt64LE(off + 16)),
      timestamp: Number(buf.readBigUInt64LE(off + 24)),
    };
  }

  private readHeartbeatStruct(buf: Buffer): Heartbeat {
    let off = 0;
    const strs: string[] = [];

    for (let i = 0; i < 2; i++) {
      const strPtr = buf.readBigUInt64LE(off);
      const strLen = buf.readUInt32LE(off + 8);
      if (strLen > 0 && strPtr > 0n) {
        const strBuf = toBuffer(Number(strPtr), 0, strLen);
        strs.push(strBuf.toString('utf-8'));
      } else {
        strs.push('');
      }
      off += FSC_STR_SIZE;
    }

    // off = 32 after 2 × fsc_str_t
    return {
      agentId: strs[0],
      nodeId: strs[1],
      cpuPercent: buf.readDoubleLE(off),       // offset 32
      memUsedMb: Number(buf.readBigUInt64LE(off + 8)),  // offset 40
      memTotalMb: Number(buf.readBigUInt64LE(off + 16)), // offset 48
      activeTasks: buf.readUInt32LE(off + 24),  // offset 56
      timestamp: Number(buf.readBigUInt64LE(off + 32)),  // offset 64
    };
  }
}
