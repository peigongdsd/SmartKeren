export function db_initTenantTable(db) {
    //When recording unix time, no need to quotient by 1000!!!
    return db.prepare(`
      CREATE TABLE IF NOT EXISTS tenant (
        uuid TEXT PRIMARY KEY,
        openid TEXT NOT NULL UNIQUE,
        validFrom INTEGER NOT NULL,
        validUntil INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tenant_openid ON tenant(openid);
    `);
}

export function db_nucTenantTable(db) {
    console.log("I'm not gonna do this!");
    return db.prepare("");
}

export function db_updateUser(db, openid, validFrom, validUntil) {
    // No check for injection since we do trust wechat
    return db.prepare(`
        INSERT INTO tenant (uuid, openid, validFrom, validUntil)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(openid) DO UPDATE SET
            validFrom  = excluded.validFrom,
            validUntil = excluded.validUntil
      `).bind(crypto.randomUUID(), openid, validFrom, validUntil);
}

export function db_deleteUser(db, openid) {
    return db.prepare(`
        DELETE FROM tenant
        WHERE openid = ?
      `).bind(openid);
}

export async function db_userExpired(db, openid) {
    // 1. Compute current Unix time (seconds)
    const now = Math.floor(Date.now() / 1000);

    // 2. Run the SQL expiration check entirely on SQLite side
    const row = await db.prepare(`
    SELECT
      CASE
        WHEN (SELECT validUntil FROM tenant WHERE openid = ?) IS NULL THEN 1
        WHEN (SELECT validUntil FROM tenant WHERE openid = ?) <  ? THEN 1
        ELSE 0
      END AS expired;
  `)
        .bind(openid, openid, now)
        .first();  // returns { expired: number }

    // 3. Interpret `1` as true, `0` as false
    return row.expired === 1;
}

export async function dbcommit(db, transactions) {
    return await db.batch(transactions);
}

