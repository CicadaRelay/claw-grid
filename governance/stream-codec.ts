/**
 * FSC-Mesh Stream Codec — msgpack + JSON 双格式编解码
 *
 * 新 worker 用 msgpack 编码 (省 30-50% 内存)，旧 worker 用 JSON。
 * 消费端通过 `encoding` 字段自动识别格式。
 *
 * 当 libfsc-ffi.so 可用时，task_result 类型的 msgpack 走 C 零拷贝路径。
 * 其他类型 fallback 到 @msgpack/msgpack。
 */

import { encode, decode } from '@msgpack/msgpack';
import { FscCodec } from '../c/fsc-codec/ffi-bun';
import { resolve } from 'path';

// 尝试加载 C codec，失败则 fallback 到纯 TS
let codec: FscCodec | null = null;
try {
  const libPath = resolve(import.meta.dir, '../c/fsc-codec/libfsc-ffi.so');
  codec = new FscCodec(libPath);
  console.log(`[StreamCodec] C FFI loaded: ${codec.version()}`);
} catch {
  console.log('[StreamCodec] C FFI unavailable, using @msgpack/msgpack fallback');
}

/**
 * 解码 Stream 消息 — 自动识别 msgpack/JSON
 * msgpack 格式: { payload: base64(msgpack), encoding: 'msgpack' }
 * JSON 格式 (旧版): 各字段直接存储
 */
export function decodeStreamMessage(message: Record<string, string>): Record<string, unknown> {
  if (message.encoding === 'msgpack' && message.payload) {
    // 结构化 result 走 C codec 零拷贝路径
    if (codec && message.type === 'task_result') {
      try {
        return codec.decodeResultB64(message.payload) as unknown as Record<string, unknown>;
      } catch {
        // fallback to TS
      }
    }
    const buf = Buffer.from(message.payload, 'base64');
    return decode(buf) as Record<string, unknown>;
  }
  return message;
}

/**
 * 编码数据为 Stream 友好的 msgpack 格式
 * 返回 { payload: base64(msgpack), encoding: 'msgpack' }
 */
export function encodeStreamMessage(data: Record<string, unknown>): { payload: string; encoding: string } {
  const buf = Buffer.from(encode(data));
  return {
    payload: buf.toString('base64'),
    encoding: 'msgpack',
  };
}

/** 获取当前 codec 状态 */
export function getCodecInfo(): { native: boolean; version: string | null } {
  return {
    native: codec !== null,
    version: codec?.version() ?? null,
  };
}
