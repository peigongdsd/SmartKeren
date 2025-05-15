import { callAzureAI } from "./azure_ai.js";

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const params = url.searchParams;

  //for debug only
  if (url.pathname === "/list-all-kv0-1919810") {
    return debug_inspectkv(url, env.kv0, env.kvs, ctx);
  }
  else if (url.pathname === "/list-all-kvs-1919810") {
    return debug_inspectkv(url, env.kvs, env.kvs, ctx);
  }
  else if (url.pathname === "/test-ai-1919810") {
    const query = params.get('query') || '';
    return new Response(await callAzureAI(env, query, null), { status : 200 });
    //return callAzureAIFoundry(env, query, null);
  }

  const signature = params.get('signature') || '';
  const timestamp = params.get('timestamp') || '';
  const nonce = params.get('nonce') || '';
  const echostr = params.get('echostr') || '';


  // 1. 签名校验：GET 请求用于首次验证服务器地址
  const hash = await sha1([env.token, timestamp, nonce].sort().join(''));
  if (request.method === 'GET') {
    if (hash === signature) {
      //log to stream
      ctx.waitUntil(env.kvs.put(timestamp, "verification"));
      return new Response(echostr, { status: 200 });
    }
    return new Response('Invalid signature', { status: 403 });
  }

  // 2. POST 请求：校验签名后处理消息
  if (request.method === 'POST') {
    if (hash == signature) {
      const xml = await request.text();
      //log to stream
      ctx.waitUntil(env.kvs.put(timestamp, xml));
      const msg = parseMessage(xml);
      const replyXml = await buildReply(env, msg);
      return new Response(replyXml, {
        status: 200,
        headers: { 'Content-Type': 'application/xml' }
      });
    }
    return new Response('Invalid signature', { status: 403 });
  }

  return new Response('Method Not Allowed', { status: 405 });
}


//Debug list all KV-s
async function debug_inspectkv(url, kv, kvstream, ctx) {
  ctx.waitUntil(kvstream.put(Date.now(), "inspect"));
  let cursor;
  const entries = [];
  do {
    const list = await kv.list({ 
      cursor, 
      limit: 1000 
    });
    cursor = list.cursor;
    // collect key names
    for (const { name } of list.keys) {
      entries.push(name);
    }
  } while (cursor);

  // 2) Fetch all values in parallel
  //    (for very large KV, you may want to stream or batch)
  const pairs = await Promise.all(
    entries.map(async key => {
      const val = await kv.get(key);
      return `${key}:\t${val ?? ""}`;
    })
  );
  // 3) Join with newline and return as plain text
  const body = pairs.join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain;charset=UTF-8" }
  });
}

// Calculate SHA1
async function sha1(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  // to hex
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// 简单正则解析微信 XML 中常用字段
function parseMessage(xml) {
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

// 构建文本回复
async function buildReply(env, msg) {
  const toUser = msg.FromUserName;
  const fromUser = msg.ToUserName;
  const now = Math.floor(Date.now() / 1000);
  //const content = `猫猫虫回答-3：${msg.Content || msg.Event}`;
  const content = await callAzureAI(env, msg.Content || msg.Event, null);
  return `<xml>
  <ToUserName><![CDATA[${toUser}]]></ToUserName>
  <FromUserName><![CDATA[${fromUser}]]></FromUserName>
  <CreateTime>${now}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${content}]]></Content>
</xml>`;
}