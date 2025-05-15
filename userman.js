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
    console.log("I am not gonna do this!");
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

export async function dbcommit(db, transactions) {
    return await db.batch(transactions);
}

export async function userExpired(env, openid) {
    if (await isAdmin(env, openid)) {
        return false;
    } else {
        const row = await db
            .prepare(`SELECT validUntil FROM tenant WHERE openid = ?`)
            .bind(openid)
            .first();

        // If no row found, return expired
        if (!row) {
            return true;
        } else {
            return Date.now() > row.validUntil;
        }
    }
}

export async function isAdmin(env, openid) {
    const permission = await env.admins.get(openid);
    return (permission === "Admin") 
}

