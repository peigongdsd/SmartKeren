import { callAzureAI } from "./azure_ai.js";
import { parseMessageRaw } from "./clientmsg.js";
import { isAdmin } from "./userman.js";
import { DurableObject } from "cloudflare:workers";

const deadTime = 3;
const deadKnock = 2;

/*
Table clientMsg
  MsgId (Int64, primary, no null) |
  Timestamp (Int64, indexed, no null) |
  RemoteOID (Int64, indexed, no null) |
  LocalOID (Int64, no null) |
  MsgType (Enum from "text"/"image") |
  Content (Text) |
  Extra (Text) |
  Replied (BOOL, no null, default false) |
  Knock (small Int, no null, default 0)
*/

/*
Table backendMsg
  MsgidRelated (Int64, no null) |
  Sequence (Int64, no null, default 0 ) |
  MsgType (Enum from "text"/"voice") |
  ContentText (Text, nullable) |
  ContentVoice (Voice, nullable) |
  
  primary key associate (MsgidRelated, Sequence)
*/

/*
Table transactions 
  TBD
*/



export class AgentFlashMemory extends DurableObject {
  constructor(ctx, env) {
    // Required, as we're extending the base class.
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`

      PRAGMA foreign_keys = ON;

      -- clientMsg table
      CREATE TABLE IF NOT EXISTS clientMsg (
        MsgId       INTEGER       NOT NULL PRIMARY KEY,
        -- Timestamp is in seconds!!
        Timestamp   INTEGER       NOT NULL,
        RemoteOID   TEXT          NOT NULL,
        LocalOID    TEXT          NOT NULL,
        MsgType     TEXT          NOT NULL
                          CHECK (MsgType IN ('text', 'image')),
        -- text = text, image = picUrl
        Content     TEXT,
        Extra       TEXT,
        -- 0 = not replied, 1 = replied
        Replied     INTEGER       NOT NULL DEFAULT 0, 
        Knock       INTEGER       NOT NULL DEFAULT 0
      );

      -- Indexes for clientMsg
      CREATE INDEX IF NOT EXISTS idx_clientMsg_Timestamp
        ON clientMsg (Timestamp);
      CREATE INDEX IF NOT EXISTS idx_clientMsg_RemoteOID
        ON clientMsg (RemoteOID);


      -- backendMsg table with Sequence as primary key
      CREATE TABLE IF NOT EXISTS backendMsg (
        MsgIdRelated   INTEGER   NOT NULL,
        -- Multiple replies must be inserted atomically!!!
        Sequence       INTEGER   NOT NULL PRIMARY KEY,
        MsgType        TEXT      NOT NULL
                           CHECK (MsgType IN ('text','voice')),
        ContentText    TEXT,
        ContentVoice   BLOB,
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
 * Push or knock a message, with automatic “dead” handling.
 * New message: push; Old message: Knock; Deadline message: Handle
 *
 * @param {number}  msgId
 * @param {number}  timestamp   — seconds since epoch when msg was first seen
 * @param {number}  remoteOID
 * @param {number}  localOID
 * @param {string}  msgType     — 'text' or 'image'
 * @param {string}  content
 * @param {string}  extra
 * @param {number}  deadKnock   — number of knocks before we consider “dead”
 * @param {number}  deadTimeout — seconds after timestamp before we consider “dead”
 * 
 * return { state: "waiting"/"replied"/"dead" }
 */
  async pushMsg(msgId
    , timestamp
    , remoteOID
    , localOID
    , msgType
    , content
    , extra
    , deadKnock
    , deadTimeout) {
    /*
    write this code. Push message into clientMsg. Do most of works in SQL to avoid latency from code to durable object
      If msgid already existed then
        If replied then return { "state": "replied" }
        else {
          knock = knock + 1
          if (knock >= deadknock) && ( currenttime in seconds >= deadTimeout + timestamp ) then { deadHandler() }
          else return { "state" : "waiting", "knock" : knock }
        }
      otherwise return { "state" : "waiting", "knock" : 0 }
    */

    // 1. Try to insert as a new message (Replied=0, Knock=0). If it already exists, changes === 0.
    const insertResult = await this.sql
      .prepare(`
        INSERT INTO clientMsg
          (MsgId, Timestamp, RemoteOID, LocalOID, MsgType, Content, Extra, Replied, Knock)
        VALUES (?,       ?,         ?,         ?,        ?,       ?,       ?,     0,       0)
        ON CONFLICT(MsgId) DO NOTHING
      `)
      .bind(
        msgId,
        timestamp,
        remoteOID,
        localOID,
        msgType,
        content,
        extra
      )
      .run();

    // 2a. Was a new row inserted? If so, first push → waiting with 0 knocks.
    if (insertResult.changes > 0) {
      return { state: "waiting" };
    }

    // 2b. Existing message: fetch its Replied flag and current knock count
    const row = await this.sql
      .prepare(`SELECT Replied, Knock FROM clientMsg WHERE MsgId = ?`)
      .bind(msgId)
      .first();

    // 3. If already replied, bail out
    if (row.Replied === 1) {
      return { state: "replied" };
    }

    // 4. Otherwise increment knock
    const newKnock = row.Knock + 1;
    await this.sql
      .prepare(`UPDATE clientMsg SET Knock = ? WHERE MsgId = ?`)
      .bind(newKnock, msgId)
      .run();

    // 5. Check “dead” condition: too many knocks *and* timed out
    const now = Math.floor(Date.now() / 1000);
    if (newKnock >= deadKnock && now >= timestamp + deadTimeout) {
      // invoke user-provided handler, return its result
      return { state: "dead" };
    }

    // 6. Otherwise still waiting
    return { state: "waiting" };
  }

  /**
 * Mark a message as replied.
 * @param {number} msgId
 * @returns {{updated: number}}  // number of rows that were changed (0 or 1)
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
 * Push a new reply from the backend.
 * Automatically increments Sequence for this MsgIdRelated.
 *
 * @param {number} msgIdRelated
 * @param {'text'|'voice'} msgType
 * @param {string|null} text         — if msgType==='text'
 * @param {Uint8Array|null} voice    — if msgType==='voice'
 * @returns {{ MsgIdRelated: number, Sequence: number }}
 */

  async pushReply(msgIdRelated, msgType, text = null, voice = null) {    // Single-statement insert with built-in sequencing and returning:
    const row = await this.sql
      .prepare(`
          INSERT INTO backendMsg
            (MsgIdRelated, Sequence, MsgType, ContentText, ContentVoice)
          SELECT ?,                COALESCE(MAX(Sequence), -1) + 1, ?,       ?,      ?
            FROM backendMsg
           WHERE MsgIdRelated = ?
          RETURNING Sequence;
        `)
      .bind(
        msgIdRelated,
        msgType,
        msgType === 'text' ? text : null,
        msgType === 'voice' ? voice : null,
        msgIdRelated
      )
      .first();  // runs the statement and returns the first (only) row
    return { MsgIdRelated: msgIdRelated, Sequence: row.Sequence };
  }

  /**
  * Peek for backend replies to a given client message.
  * @param {number} msgId
  * @returns {Promise<
  *   { status: "replied" } 
  *   | { status: "ready", messages: Array<{ sequence: number, msgType: string, content: string|Uint8Array }> } 
  *   | { status: "waiting" }
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
        SELECT Sequence, MsgType, ContentText, ContentVoice
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
        content: r.MsgType === "text"
          ? r.ContentText
          : r.ContentVoice    // Uint8Array from BLOB
      }));
      return { status: "ready", messages };
    }

    // 4. No reply yet
    return { status: "waiting" };
  }

  /**
     * Fetch the last `n` client messages for a given remoteOID,
     * then load all corresponding **text** backend replies for each message.
     *
     * @param {number} n
     * @param {string} remoteOID
     * @returns {Promise<
  *   Array<{
  *     user:  { type: string, content: any },
  *     agent: Array<{ type: string, content: any }>
  *   }>
  * >}
  */
  async getContext(n, remoteOID) {
    // 1. Get up to `n` most recent client messages
    const userRows = await this.sql
      .prepare(`
     SELECT MsgId, MsgType, Content
       FROM clientMsg
      WHERE RemoteOID = ?
      ORDER BY Timestamp DESC
      LIMIT ?
   `)
      .bind(remoteOID, n)
      .all();  // Array of { MsgId, MsgType, Content }

    const contexts = [];

    // 2. For each user message, fetch only text replies
    for (const { MsgId, MsgType, Content } of userRows) {
      const backendTextRows = await this.sql
        .prepare(`
       SELECT MsgType, ContentText
         FROM backendMsg
        WHERE MsgIdRelated = ?
          AND MsgType = 'text'
        ORDER BY Sequence ASC
     `)
        .bind(MsgId)
        .all();  // Returns only rows where MsgType='text' :contentReference[oaicite:4]{index=4}

      // 3. Map to the desired shape
      const agentMsgs = backendTextRows.map(r => ({
        type: r.MsgType,      // always 'text' here :contentReference[oaicite:5]{index=5}
        content: r.ContentText
      }));  // Using Array.prototype.map to transform rows :contentReference[oaicite:6]{index=6}

      contexts.push({
        user: { type: MsgType, content: Content },
        agent: agentMsgs
      });
    }

    return contexts;
  }

}

export default {
  async fetch(request, env, ctx) {
    //return handleRequest(request, env, ctx);
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

    case 'list-all-kv0':
      return debug_inspectkv(url, env.kv0, env.kvs, ctx);

    case 'list-all-kvs':
      return debug_inspectkv(url, env.kvs, env.kvs, ctx);

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
          const replyXml = formatRichMsgOneshot(msg.meta.fromUser, msg.meta.toUser, '原神，启动！', '跟我一起来提瓦特大陆冒险吧！', 'https://genshin.hoyoverse.com/favicon.ico', 'https://genshin.hoyoverse.com/');
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

async function handleAdmin() {

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
    const picurl = params.get('picurl') || '';

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
                const replyXml = formatRichMsgOneshot(msg.meta.fromUser, msg.meta.toUser, '原神，启动！', '跟我一起来提瓦特大陆冒险吧！', 'https://genshin.hoyoverse.com/favicon.ico', 'https://genshin.hoyoverse.com/');
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
