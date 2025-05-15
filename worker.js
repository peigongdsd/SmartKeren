import { callAzureAI } from "./azure_ai.js";
import { parseMessageRaw } from "./clientmsg.js";
import { isAdmin } from "./userman.js";
import { DurableObject } from "cloudflare:workers";
export class AgentFlashMemory extends DurableObject {
  constructor(ctx, env) {
    // Required, as we're extending the base class.
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
        CREATE TABLE IF NOT EXISTS memory (
          MsgId     INTEGER PRIMARY KEY,
          UserName  TEXT NOT NULL,
          Timestamp INTEGER NOT NULL,
          MsgType   TEXT NOT NULL CHECK (MsgType IN ('Text','Pic','Voice')),
          Content   TEXT,
          Extra     TEXT
        );
      `);
  }
  async sayHello() {
    let result = this.ctx.storage.sql
      .exec("SELECT 'Hello, World!' as greeting")
      .one();
    return result.greeting;
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const params = url.searchParams;

  if (url.pathname === "/fetch_access_token") {
    // Fetch Access Token and stor
  }

  //for debug only
  if (url.pathname === "/subs") {
    return new Response(arams.get('reserved') || 'none', {
      headers: { "Content-Type": "text/plain;charset=UTF-8" }
    });
  }
  if (url.pathname === "/list-all-kv0-1919810") {
    return debug_inspectkv(url, env.kv0, env.kvs, ctx);
  }
  else if (url.pathname === "/list-all-kvs-1919810") {
    return debug_inspectkv(url, env.kvs, env.kvs, ctx);
  }
  else if (url.pathname === "/test-ai-1919810") {
    const query = params.get('query') || '';
    const pic = params.get('picurl') || '';
    return new Response(await callAzureAI(env, query, picurl), { status: 200 });
    //return callAzureAIFoundry(env, query, null);
  }
  //debug end

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
    try {
      if (hash == signature) {
        const xml = await request.text();
        //log to stream
        ctx.waitUntil(env.kvs.put(Date.now(), xml));
        const msg = await parseMessageRaw(xml, env);
        let reply = "";
        switch (msg.type) {
          case "text":
            const clientoid = msg.meta.fromUser;
            if (isAdmin(env, clientoid)) {
              // All priviledged instructions must start with #
              if (msg.data.content.charAt(0) === '#') {
                // Escape to admin mode and do something
                const subsurl = formatOneshotSubs(env.appid, "0", "0", "https://webot0.krusllee.com/subs", "tokenb80vt7c0t");
                const replyXml = formatRichMsgOneshot(msg.meta.fromUser, msg.meta.toUser, '原神，启动！', '跟我一起来提瓦特大陆冒险吧！', 'https://genshin.hoyoverse.com/favicon.ico', subsurl);
                //const replyXml = formatTextMsg(msg.meta.fromUser, msg.meta.toUser, 'Privilege Confirmed');
                return new Response(subsurl, {
                  status: 200,
                  headers: { 'Content-Type': 'application/xml' }
                });
              }
            }
            reply = await callAzureAI(env, msg.data.content, null);
            break;
          case "image":
            reply = await callAzureAI(env, null, msg.data.picUrl);
            break;
          default:
            reply = "对不起，暂时还不支持这种类型的消息";
        }
        const replyXml = formatTextMsg(msg.meta.fromUser, msg.meta.toUser, reply);

        return new Response(replyXml, {
          status: 200,
          headers: { 'Content-Type': 'application/xml' }
        });
      }
    } catch (error) {
      ctx.waitUntil(env.kvs.put(Date.now() + 5, error));
      return new Response('success', { status: 200 });
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

function formatOneshotSubs(appid, scene, template_id, redirect_url, reserved) {
  return `https://mp.weixin.qq.com/mp/subscribemsg?action=get_confirm&appid=${appid}&scene=${scene}&template_id=${template_id}&redirect_url=${redirect_url}&reserved=${reserved}#wechat_redirect`;
}

function formatTextMsg(toUser, fromUser, content) {
  return `<xml>
  <ToUserName><![CDATA[${toUser}]]></ToUserName>
  <FromUserName><![CDATA[${fromUser}]]></FromUserName>
  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${content}]]></Content>
</xml>`;
}

function formatRichMsgOneshot(toUser, fromUser, title, description, picUrl, jumpUrl) {
  return `<xml>
  <ToUserName><![CDATA[${toUser}]]></ToUserName>
  <FromUserName><![CDATA[${fromUser}]]></FromUserName>
  <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
  <MsgType><![CDATA[news]]></MsgType>
  <ArticleCount>1</ArticleCount>
  <Articles>
    <item>
      <Title><![CDATA[${title}]]></Title>
      <Description><![CDATA[${description}]]></Description>
      <PicUrl><![CDATA[${picUrl}]]></PicUrl>
      <Url><![CDATA[${jumpUrl}]]></Url>
    </item>
  </Articles>
</xml>`;
}
