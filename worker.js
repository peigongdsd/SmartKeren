import { stringifyParsedURL } from "ufo";
import { callAzureAI } from "./azure_ai.js";
import { parseMessage, parseMessageRaw } from "./clientmsg.js";
import { isAdmin } from "./userman.js";
import { DurableObject } from "cloudflare:workers";

//const deadTime = 3;
//const defaultTTL = 2;


/*
NEW DESIGN: Separated namespace for each openid, greatly simplified

Table meta (only one record, read only)
  -- uuid generate on 
  uuid (uuid, primary)
  remoteOID (text)
  localOID (text)
  -- enroll unix timestamp on created
  since (int64)


Table clientMsg
  MsgId (Int64, primary, no null) |
  Timestamp (Int64, indexed, no null) |
  MsgType (Enum from "text"/"image") |
  Content (Text) |
  Extra (Text) |
  Replied (BOOL, no null, default false) |
  Knock (small Int, no null, default 0)

Table backendMsg
  MsgidRelated (Int64, no null) |
  Sequence (Int64, no null, default 0 ) |
  MsgType (Enum from "text"/"voice") |
  ContentText (Text, nullable) |
  ContentVoice (Voice, nullable) |
  
  primary key associate (MsgidRelated, Sequence)

*/

export class AgentFlashMemory extends DurableObject {
  sql;
  constructor(ctx, env) {
    console.log(ctx.id.name);
    let identifiers = JSON.parse(ctx.id.name);
    // Required, as we're extending the base class.
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`

      -- maybe we do not need this
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS meta (
        RemoteOID TEXT,                  -- free-form text
        LocalOID  TEXT,                  -- free-form text
        CreateOn  INTEGER PRIMARY KEY     -- signed 64-bit, perfect for Unix timestamps
      );

      INSERT OR REPLACE INTO meta(remoteOID, localOID, CreateOn)
      VALUES(${identifiers.remoteOID}, ${identifiers.localOID}, ${Date.now()});

      -- clientMsg table
      CREATE TABLE IF NOT EXISTS clientMsg (
        MsgId       INTEGER       NOT NULL PRIMARY KEY,
        -- CreateTime is in seconds, from tencent
        CreateTime  INTEGER       NOT NULL,
        MsgType     TEXT          NOT NULL
                          CHECK (MsgType IN ('text', 'image', 'voice', 'video', 'shortvideo','location', 'link')),
        -- text = text, image = picUrl
        RawJSON     TEXT          NOT NULL,
        -- 0 = not replied, 1 = replied
        Replied     INTEGER       NOT NULL DEFAULT 0
      );

      -- Indexes for clientMsg
      CREATE INDEX IF NOT EXISTS idx_clientMsg_CreateTime
        ON clientMsg (CreateTime);


      -- backendMsg table with Sequence as primary key
      CREATE TABLE IF NOT EXISTS backendMsg (
        MsgIdRelated   INTEGER   NOT NULL,
        -- Multiple replies must be inserted atomically!!!
        Sequence       INTEGER   NOT NULL PRIMARY KEY AUTOINCREMENT,
        MsgType        TEXT      NOT NULL
                           CHECK (MsgType IN ('text','voice','image')),
        RawJSON    TEXT,
        -- Link the two tables
        FOREIGN KEY (MsgIdRelated)
          REFERENCES clientMsg (MsgId)
          ON DELETE CASCADE
          ON UPDATE NO ACTION
      );

      -- index on MsgIdRelated for fast lookups
      CREATE INDEX IF NOT EXISTS idx_backendMsg_MsgIdRelated
        ON backendMsg (MsgIdRelated);
    `);

  }

  /**
   * Dump every row from meta, clientMsg, and backendMsg.
   * @returns {Promise<{ meta: any[]; clientMsg: any[]; backendMsg: any[] }>}
   */
  async debug_dumpall() {
    // Get all rows from meta
    const metaRows = this.sql
      .exec(`SELECT RemoteOID, LocalOID, CreateOn FROM meta`)
      .all();                                        // :contentReference[oaicite:0]{index=0}

    // Get all rows from clientMsg
    const clientRows = this.sql
      .exec(`SELECT MsgId, CreateTime, MsgType, RawJSON, Replied FROM clientMsg`)
      .all();                                        // :contentReference[oaicite:1]{index=1}

    // Get all rows from backendMsg
    const backendRows = this.sql
      .exec(`SELECT MsgIdRelated, Sequence, MsgType, RawJSON FROM backendMsg`)
      .all();                                        // :contentReference[oaicite:2]{index=2}

    // Return combined result
    return {
      meta: metaRows.results,
      clientMsg: clientRows.results,
      backendMsg: backendRows.results,
    };
  }


  /**
   * Push a message record into clientMsg with initial state.
   * @param {number} msgId - Unique identifier for the message
   * @param {number} createTime - Epoch seconds when the message was first seen
   * @param {'text'|'image'|'voice'|'video'|'shortvideo'|'location'|'link'} msgType
   * @param {object} rawJSON - The parsed JSON content of the message
   * @returns {Promise<{ state: 'pending' | 'replied' }>}
   */
  async pushMsg(msgId
    , createTime
    , msgType
    , rawJSON
  ) {

    // 1. Try to insert as a new message (Replied=0, Knock=0). If it already exists, changes === 0.
    const insertResult = await this.sql
      .prepare(`
        INSERT INTO clientMsg
          (MsgId, CreateTime, MsgType, RawJSON)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(MsgId) DO NOTHING
      `)
      .bind(
        msgId,
        createTime,
        msgType,
        JSON.stringify(rawJSON)
      )
      .run();

    // 2a. Was a new row inserted? If so, first push → waiting with 0 knocks.
    if (insertResult.changes > 0) {
      return { state: "pending" };
    } else {
      const row = await this.sql
        .prepare(`SELECT Replied, Knock FROM clientMsg WHERE MsgId = ?`)
        .bind(msgId)
        .first();

      // 3. If already replied, bail out
      if (row.Replied === 1) {
        return { state: "replied" };
      } else
        return { state: "pending" };
    }
  }

  /**
   * Mark a message as replied in clientMsg.
   * @param {number} msgId
   * @returns {Promise<{ updated: number }>}
   */
  async replyMsg(msgId) {
    /* set the replied for the msgId to be 1 if msgid exist. Otherwise do nothing.  */
    const result = await this.sql
      .prepare(`
      UPDATE clientMsg
         SET Replied = 1
       WHERE MsgId = ?
    `)
      .bind(msgId)
      .run();

    // result.changes is the number of rows updated
    return { updated: result.changes };
  }

  /**
   * Insert a new reply into backendMsg, auto-incrementing Sequence.
   * @param {number} msgIdRelated - The clientMsg.MsgId this reply belongs to
   * @param {'text'|'voice'|'image'} msgType
   * @param {object|string|null} rawJSON - The reply content; will be JSON-stringified if object
   * @returns {Promise<number>} - Number of rows inserted (1 on success)
   */
  async pushReply(msgIdRelated, msgType, rawJSON) {    // Single-statement insert with built-in sequencing and returning:
    const insertResult = await this.sql
      .prepare(`
          INSERT INTO backendMsg
            (MsgIdRelated, MsgType, rawJSON)
          VALUES (?, ?, ?)
        `)
      .bind(
        msgIdRelated,
        msgType,
        JSON.stringify(rawJSON)
      )
      .run();
    return (insertResult.changes);
  }

  /**
   * Peek for backend replies to a given client message.
   * @param {number} msgId
   * @returns {Promise<
  *   { status: 'replied' } |
  *   { status: 'ready'; messages: Array<{ sequence: number; msgType: string; content: any }> } |
  *   { status: 'pending' }
  * >}
  */
  async peekReply(msgId) {
    // 1. Check if the client message was already replied
    const clientRow = await this.sql
      .prepare(`SELECT Replied FROM clientMsg WHERE MsgId = ?`)
      .bind(msgId)
      .first();

    if (clientRow?.Replied === 1) {
      return { status: "replied" };
    }

    // 2. Fetch any backend messages for this msgId, sorted by Sequence
    const backendRows = await this.sql
      .prepare(`
        SELECT Sequence, MsgType, rawJSON
          FROM backendMsg
         WHERE MsgIdRelated = ?
         ORDER BY Sequence ASC
      `)
      .bind(msgId)
      .all();

    if (backendRows.length > 0) {
      // 3. Map raw rows into a JS-friendly messages array
      const messages = backendRows.map(r => ({
        sequence: r.Sequence,
        msgType: r.MsgType,
        content: JSON.parse(r.RawJSON)
      }));
      return { status: "ready", messages };
    }

    // 4. No reply yet
    return { status: "pending" };
  }

  /**
   * Fetch the last `n` client messages and their backend replies.
   * @param {number} n - Number of recent client messages to retrieve
   * @returns {Promise<Array<{ user: { type: string; content: any }; agent: Array<{ type: string; content: any }> }>>}
   */
  async getContext(n) {
    // 1. Get up to `n` most recent client messages
    const userRows = await this.sql
      .prepare(`
     SELECT MsgId, MsgType, rawJSON
       FROM clientMsg
      ORDER BY Timestamp DESC
      LIMIT ?
   `)
      .bind(n)
      .all();  // Array of { MsgId, MsgType, rawJSON }

    const contexts = [];

    // 2. For each user message, fetch only text replies
    for (const { MsgId, MsgType, RawJSON } of userRows) {
      const backendTextRows = await this.sql
        .prepare(`
       SELECT MsgType, ContentText
         FROM backendMsg
        WHERE MsgIdRelated = ?
        ORDER BY Sequence ASC
     `)
        .bind(MsgId)
        .all();

      // 3. Map to the desired shape
      const agentMsgs = backendTextRows.map(r => ({
        type: r.MsgType,      // always 'text' here :contentReference[oaicite:5]{index=5}
        content: JSON.parse(r.RawJSON)
      }));  // Using Array.prototype.map to transform rows :contentReference[oaicite:6]{index=6}

      contexts.push({
        user: { type: MsgType, content: RawJSON },
        agent: agentMsgs
      });
    }

    return contexts;
  }

}

export default {
  async fetch(request, env, ctx) {
    return await handle(request, env, ctx);
  }
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const urlpath = url.pathname.split('/').filter(Boolean);
  const params = url.searchParams;
  if (urlpath[0] === "debug") {
    return await handleDebug(urlpath.slice(1), params, env, ctx);
  } else {
    const signature = params.get('signature') || '';
    const timestamp = params.get('timestamp') || '';
    const nonce = params.get('nonce') || '';
    const echostr = params.get('echostr') || '';
    const hash = await sha1([env.token, timestamp, nonce].sort().join(''));
    if (hash === signature) {
      switch (request.method) {
        case 'GET':
          // 签名校验：GET 请求用于首次验证服务器地址
          return await handleTencentVerification(env, ctx);
        case 'POST':
          // POST 请求：校验签名后处理消息
          try {
            const xml = await request.text();
            return await handleMessage(xml, env, ctx);
          }
          catch (error) {
            ctx.waitUntil(env.kvs.put(Date.now() + 5, error));
            return new Response('success', { status: 200 });
          }
        default:
      }
      return new Response('Method Not Allowed', { status: 405 });
    } else {
      return new Response('Invalid signature', { status: 403 });
    }
  }
}

async function handleDebug(urlpath, params, env, ctx) {
  switch (urlpath.at(0)) {

    case 'subs':
      return new Response(
        params.get('reserved') || 'none',
        { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }
      );

    case 'test-durable':
      const id = env.agentFlashMemory.idFromName(JSON.stringify({ remoteOID: 114514, localOID: 1919810 }));
      const stub = env.agentFlashMemory.get(id);
      console.log(stub.sql);
      return new Response("Success", { status: 200 });

    case 'list-all-kv0':
      return await debug_inspectkv(env.kv0, env.kvs, ctx);

    case 'list-all-kvs':
      return await debug_inspectkv(env.kvs, env.kvs, ctx);

    case 'test-ai':
      const query = params.get('query') || '';
      const pic = params.get('picurl') || '';
      // note: pass `pic` (not `picurl`) unless your function expects the raw param name
      const aiResult = await callAzureAI(env, query, pic);
      return new Response(aiResult, { status: 200 });

    case 'test-final':
      const msg = params.get('msg') || '';
      return await handleMessage(msg, env, ctx);

    default:

  }
  return new Response('Not Found', { status: 404 });
}

async function handleTencentVerification(env, ctx) {
  ctx.waitUntil(env.kvs.put(timestamp, "verification"));
  return new Response(echostr, { status: 200 });
}

async function handleMessage(xml, env, ctx) {
  //log to stream
  ctx.waitUntil(env.kvs.put(Date.now(), xml));
  const rawMsg = await parseMessageRaw(xml, env);
  const msg = await parseMessage(rawMsg, env);
  let reply = "";

  // first check if message is already replied
  //  pushmsg, if already replied then pass
  // then wait until reply 

  switch (msg.type) {
    case "text":
      const clientoid = msg.meta.fromUser;
      if (isAdmin(env, clientoid)) {
        // All priviledged instructions must start with #
        if (msg.data.content.charAt(0) === '#') {
          return await handleAdmin(msg.slice(1));
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

async function handleAdmin(msg) {
  if (msg.data.content.charAt(0) === '#') {
    // Escape to admin mode and do something
    const subsurl = formatOneshotSubs(env.appid, "0", "0", "https://webot0.krusllee.com/subs", "tokenb80vt7c0t");
    const replyXml = formatRichMsgOneshot(msg.meta.fromUser, msg.meta.toUser, '原神，启动！', '跟我一起来提瓦特大陆冒险吧！', 'https://genshin.hoyoverse.com/favicon.ico', 'https://genshin.hoyoverse.com/');
    //const replyXml = formatTextMsg(msg.meta.fromUser, msg.meta.toUser, 'Privilege Confirmed');
    return new Response(replyXml, {
      status: 200,
      headers: { 'Content-Type': 'application/xml' }
    });
  }
}


//Debug list all KV-s
async function debug_inspectkv(kv, kvstream, ctx) {
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
      return `${key}: \t${val ?? ""} `;
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
