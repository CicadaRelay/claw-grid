/**
 * FSC-Mesh Stream Codec — msgpack + JSON 双格式编解码
 *
 * 新 worker 用 msgpack 编码 (省 30-50% 内存)，旧 worker 用 JSON。
 * 消费端通过 `encoding` 字段自动识别格式。
 */

import { encode, decode } from '@msgpack/msgpack';

/**
 * 解码 Stream 消息 — 自动识别 msgpack/JSON
 * msgpack 格式: { payload: base64(msgpack), encoding: 'msgpack' }
 * JSON 格式 (旧版): 各字段直接存储
 */
export function decodeStreamMessage(message: Record<string, string>): Record<string, unknown> {
  if (message.encoding === 'msgpack' && message.payload) {
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
