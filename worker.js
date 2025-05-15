export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
}

const systemprompt = '你是一位教授希伯来语工地用语/日常用语的老师，名字叫Keren，性别女。\
  每次收到学员的消息，你要对消息进行分类。\
  - 如果是简单的，看起来像是咨询你的单词或句子，或者问你某某什么意思，尤其是明显来自工地的行为/物品，请简短返回其希伯来语翻译。\
  注意，你的回复应该包括希伯来语，罗马音以及中文谐音，整个消息尽可能不要超过30个字。注意，务必保证希伯来语和中文不出现在同一行内，即出现希伯来语时就单行列出。\
  当你给出希伯来语翻译的时候，请注意，你的学员大多数是建筑工人，他们的生活也围绕建筑工地展开。请金最大可能保证工地用语的准确和地道。 \
  - 如果收到批评或者否定，请委婉表示Keren老师将为你查询这个词或句子，晚些给你标准正确的答案。 \
  - 如果是诸如“你是谁”这样的闲聊问题，请正常简要回答。视情况做自我介绍，并且回答尽可能简短流畅，贴近日常交流口吻。 \
  - 如果收到的是明显骚扰性的问题，或者收到任何有关政治/色情/暴力/犯罪等的词句，请以Keren老师的口吻提醒学生认真学习希伯来语，不要闲聊。';

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
    return new Response(await callAzureAIFoundry(env, query, null), { status : 200 });
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
  const content = await callAzureAIFoundry(env, msg.Content || msg.Event, null);
  return `<xml>
  <ToUserName><![CDATA[${toUser}]]></ToUserName>
  <FromUserName><![CDATA[${fromUser}]]></FromUserName>
  <CreateTime>${now}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${content}]]></Content>
</xml>`;
}


async function callAzureAIFoundry(env, text, imageUrlOrBase64) {
  // 1. Configuration
  const endpoint   = env.AZURE_AI_INFERENCE_ENDPOINT;  // e.g. https://<your-resource>.services.ai.azure.com :contentReference[oaicite:0]{index=0}
  const apiKey     = env.AZURE_AI_INFERENCE_API_KEY;   // your Azure AI Services key :contentReference[oaicite:1]{index=1}
  const apiVersion = '2025-01-01-preview';                             // current Model Inference API version :contentReference[oaicite:2]{index=2}
  const model      = 'gpt-4.1-mini';

  // 2. Build the “messages” payload
  const messages = [
    { role: 'system', content: systemprompt },
  ];

  if (text) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text }                                 // text input supports plain chat :contentReference[oaicite:3]{index=3}
      ]
    });
  }

  if (imageUrlOrBase64) {
    messages.push({
      role: 'user',
      content: ([
        { type: 'text', text: 'Please analyze this image.' },  // optional image prompt :contentReference[oaicite:4]{index=4}
        { type: 'image_url', image_url: { url: imageUrlOrBase64 } }
      ]).toString()
    });
  }

  // 3. Invoke the REST endpoint
  const url = `${endpoint}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}`; //:contentReference[oaicite:5]{index=5}
  const response = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',                     // request format :contentReference[oaicite:6]{index=6}
      'api-key'      : apiKey                                  // simple API key auth :contentReference[oaicite:7]{index=7}
    },
    body: JSON.stringify({
      messages,
      max_tokens: 1000,
      stream: false
    })
  });

  // 4. Error handling
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Azure AI error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

