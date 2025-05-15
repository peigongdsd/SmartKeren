// 微信消息分类器
// 支持分类：文字消息、图片消息、语音消息、链接消息
// 根据 XML 中的 MsgType 字段进行判断，并提取对应数据字段

import { parseStringPromise } from 'xml2js';

export async function parseMessageRaw(xmlMessage, env) {
    const message = await parseStringPromise(xmlMessage, {
        explicitArray: false,
        mergeAttrs: true
      });
    await env.kvs.put(timestamp, message);
    const type = message.MsgType;
    await env.kvs.put(timestamp, type);
    let data = {};
  
    switch (type) {
      case 'text':
        // 文本消息包含 Content 字段
        data = { content: message.Content };
        break;
  
      case 'image':
        // 图片消息包含 PicUrl 和 MediaId 字段
        data = { picUrl: message.PicUrl, mediaId: message.MediaId };
        break;
  
      case 'voice':
        // 语音消息包含 MediaId 和 Format 字段
        data = { mediaId: message.MediaId, format: message.Format };
        break;
  
      case 'link':
        // 链接消息包含 Title、Description、Url 字段
        data = {
          title: message.Title,
          description: message.Description,
          url: message.Url
        };
        break;
  
      default:
        // 其他类型直接返回原始消息
        data = { raw: message };
        break;
    }
  
    return { type, data };
}

// 简单正则解析微信 XML 中常用字段
export function parseMessage(xml) {
  const result = {};
  // CDATA 标签匹配
  xml.replace(/<(\w+)><!\[CDATA\[(.*?)\]\]><\/\1>/g, (_, tag, content) => {
    result[tag] = content;
  });
  // 数字标签匹配
  const numMatch = xml.match(/<CreateTime>(\d+)<\/CreateTime>/);
  if (numMatch) result.CreateTime = numMatch[1];
  return result;
}