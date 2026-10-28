import {
  beijingDate,
  nextRunAt,
  outcomeSchema,
  taskIds,
  type Credential,
  type Job,
  type Outcome,
  type QueueMessage,
} from "@heybox/contracts";

export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown>;
}
type JobRow = {
  id: string;
  user_id: string;
  date: string;
  status: string;
  attempts: number;
  version: string | null;
  lease: string | null;
  result: string | null;
  updated_at: number;
};

export class Store {
  readonly db: Database;
  readonly now: () => number;
  private retryAfterSeconds = 1800;
  get retryAfter() {
    return this.retryAfterSeconds;
  }
  constructor(db: Database, now = Date.now) {
    this.db = db;
    this.now = now;
  }
  private sql(query: string, ...values: unknown[]) {
    return this.db.prepare(query).bind(...values);
  }
  async activityCredential(userId: string): Promise<Credential | null> {
    return this.sql(
      "SELECT heybox_id AS account,version,ciphertext FROM hosting WHERE user_id=? AND credential_state='valid'",
      userId,
    ).first<Credential>();
  }
  async activityAccess(account: string, version: string) {
    return Boolean(
      await this.sql(
        "SELECT user_id FROM hosting WHERE user_id=? AND heybox_id=? AND version=? AND credential_state='valid'",
        `heybox:${account}`,
        account,
        version,
      ).first(),
    );
  }
  async enroll(credential: Credential, receipt?: { challenge: string; expiresAt: number }) {
    const id = `heybox:${credential.account}`;
    const now = this.now();
    if (receipt && receipt.expiresAt <= now) throw new Error("登录结果已过期");
    const owner = crypto.randomUUID();
    const gate = receipt ? " AND EXISTS(SELECT 1 FROM login_receipts WHERE challenge=? AND owner=?)" : "";
    const gateValues = receipt ? [receipt.challenge, owner] : [];
    await this.db.batch([
      ...(receipt ? [this.sql(
        "INSERT OR IGNORE INTO login_receipts(challenge,account,version,owner,expires_at) VALUES(?,?,?,?,?)",
        receipt.challenge, credential.account, credential.version, owner, receipt.expiresAt,
      )] : []),
      this.sql(
        `INSERT INTO user(id,name,email,image,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE 1=1${gate}
        ON CONFLICT(id) DO UPDATE SET name=COALESCE(?,user.name),image=COALESCE(?,user.image),updated_at=excluded.updated_at`,
        id,
        credential.profile?.nickname || `盒友 ${credential.account}`,
        `${credential.account}@heybox.invalid`,
        credential.profile?.avatar || null,
        now,
        now,
        ...gateValues,
        credential.profile?.nickname || null,
        credential.profile?.avatar || null,
      ),
      this.sql(
        `INSERT INTO hosting(user_id,heybox_id,ciphertext,version,enabled,credential_state,updated_at) SELECT ?,?,?,?,1,'valid',? WHERE 1=1${gate}
        ON CONFLICT(user_id) DO UPDATE SET ciphertext=excluded.ciphertext,version=excluded.version,enabled=1,credential_state='valid',updated_at=excluded.updated_at`,
        id,
        credential.account,
        credential.ciphertext,
        credential.version,
        now,
        ...gateValues,
      ),
      this.sql(
        `UPDATE jobs SET status='cancelled',updated_at=? WHERE user_id=? AND status IN ('queued','running')${gate}`,
        now,
        id,
        ...gateValues,
      ),
      ...this.enqueueStatements(id, true, now, gate, gateValues),
    ]);
    if (receipt) {
      const current = await this.sql(
        `SELECT h.version FROM hosting h JOIN login_receipts r ON h.heybox_id=r.account
         WHERE r.challenge=? AND r.version=? AND r.expires_at>?`,
        receipt.challenge, credential.version, now,
      ).first<{ version: string }>();
      if (current?.version !== credential.version) throw new Error("登录结果已失效或已被新的登录替代");
    }
    return id;
  }
  async enqueue(userId: string, retry = false) {
    await this.db.batch(this.enqueueStatements(userId, retry, this.now()));
  }
  private enqueueStatements(userId: string, retry: boolean, now: number, gate = "", gateValues: unknown[] = []) {
    const date = beijingDate(now);
    const insert = this.sql(
      `INSERT INTO jobs(id,user_id,date,status,available_at,created_at,updated_at)
      SELECT ?,user_id,?,'queued',?,?,? FROM hosting WHERE user_id=? AND enabled=1 AND credential_state='valid'${gate}
      ON CONFLICT(user_id,date) DO NOTHING`,
      crypto.randomUUID(),
      date,
      now,
      now,
      now,
      userId,
      ...gateValues,
    );
    const statements = [insert];
    if (retry)
      statements.push(
        this.sql(
          `UPDATE jobs SET status='queued',attempts=0,available_at=MAX(?,COALESCE(lease_until,0)),updated_at=?,
          queue_token=NULL,queue_published=0,dispatch_until=0
      WHERE user_id=? AND date=? AND status IN ('failed','cancelled','auth_expired')
      AND EXISTS(SELECT 1 FROM hosting WHERE user_id=? AND enabled=1 AND credential_state='valid')${gate}`,
          now,
          now,
          userId,
          date,
          userId,
          ...gateValues,
        ),
      );
    return statements;
  }
  async acquireSmsSend(key: string): Promise<{ token?: string; retryAt: number }> {
    const now = this.now();
    const token = crypto.randomUUID();
    const acquired = await this.sql(
      `INSERT INTO sms_sends(key,token,expires_at) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at
       WHERE sms_sends.expires_at<=? RETURNING token,expires_at AS retryAt`,
      key, token, now + 180_000, now,
    ).first<{ token: string; retryAt: number }>();
    if (acquired) return acquired;
    const held = await this.sql("SELECT expires_at AS retryAt FROM sms_sends WHERE key=?", key)
      .first<{ retryAt: number }>();
    return { retryAt: held?.retryAt ?? now };
  }
  async finishSmsSend(key: string, token: string, possiblySent: boolean) {
    await (possiblySent
      ? this.sql("UPDATE sms_sends SET expires_at=? WHERE key=? AND token=?", this.now() + 60_000, key, token)
      : this.sql("DELETE FROM sms_sends WHERE key=? AND token=?", key, token)).run();
  }
  async schedule() {
    const now = this.now();
    const date = beijingDate(now);
    if (now >= Date.parse(`${date}T00:01:00+08:00`)) {
      const created = await this.sql(
        `INSERT OR IGNORE INTO jobs(id,user_id,date,status,available_at,created_at,updated_at)
        SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),
        user_id,?,'queued',?,?,? FROM hosting h WHERE enabled=1 AND credential_state='valid'
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.user_id=h.user_id AND j.date=?) RETURNING id`,
        date,
        now,
        now,
        now,
        date,
      ).all<{ id: string }>();
      return created.results.length;
    }
    return 0;
  }
  async cleanup() {
    const now = this.now();
    await this.db.batch([
      this.sql("DELETE FROM rate_limits WHERE expires_at<?", now),
      this.sql("DELETE FROM sms_sends WHERE expires_at<?", now),
      this.sql("DELETE FROM login_receipts WHERE expires_at<?", now),
      this.sql("DELETE FROM session WHERE expires_at<?", now),
      this.sql("DELETE FROM jobs WHERE updated_at<?", now - 30 * 86400_000),
    ]);
  }
  private async nextWorkAt() {
    const now = this.now();
    const date = beijingDate(now);
    const row = await this.sql(
      // Most claims have immediately available work. Stop at the first indexed candidate;
      // only calculate every pending deadline when all eligible work is delayed or leased.
      `SELECT COALESCE((
        SELECT ? FROM jobs j JOIN hosting h ON h.user_id=j.user_id
        WHERE j.status='queued' AND j.date=? AND j.available_at<=?
        AND h.enabled=1 AND h.credential_state='valid'
        AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=j.user_id AND other.lease_until>=?)
        ORDER BY j.available_at,j.created_at LIMIT 1
      ),(SELECT MIN(CASE WHEN j.date<>? THEN ?
        WHEN j.status='running' THEN COALESCE(j.lease_until+1,?)
        ELSE MAX(j.available_at,COALESCE((SELECT MAX(other.lease_until)+1 FROM jobs other
          WHERE other.user_id=j.user_id AND other.lease_until>=?),0)) END) AS due
      FROM jobs j JOIN hosting h ON h.user_id=j.user_id
      WHERE j.status IN ('queued','running') AND h.enabled=1 AND h.credential_state='valid')) AS due`,
      now,
      date,
      now,
      now,
      date,
      now,
      now,
      now,
    ).first<{ due: number | null }>();
    const midnight = Date.parse(`${beijingDate(now)}T00:00:00+08:00`) + 86400_000;
    const due = Math.min(row?.due ?? now + 1_800_000, midnight);
    this.retryAfterSeconds = Math.max(1, Math.min(1800, Math.ceil((due - now) / 1000)));
    return due;
  }
  private async recover() {
    const now = this.now();
    await this.db.batch([
      this.sql(
        `UPDATE jobs SET status='cancelled',updated_at=? WHERE id IN (
          SELECT id FROM jobs WHERE status IN ('queued','running') AND date<?
          UNION ALL
          SELECT id FROM jobs WHERE status IN ('queued','running') AND date>?
        )`,
        now,
        beijingDate(now),
        beijingDate(now),
      ),
      this.sql(
        `UPDATE jobs SET status=CASE WHEN attempts<3 THEN 'queued' ELSE 'failed' END,lease=NULL,lease_until=NULL,updated_at=?,
        queue_token=NULL,queue_published=0,dispatch_until=0,
        result=json_set(json_remove(COALESCE(result,'{"status":"failed","reason":"timeout"}'),
          '$.expDelta','$.coinDelta','$.batteryDelta'),'$.uncertain',json('true'))
        WHERE status='running' AND lease_until<?`,
        now,
        now,
      ),
    ]);
  }
  async reserveDispatch(limit = 100): Promise<QueueMessage[]> {
    await this.recover();
    const now = this.now();
    const token = crypto.randomUUID();
    const rows = await this.sql(
      `UPDATE jobs SET queue_token=?,queue_published=0,dispatch_until=? WHERE id IN (
        SELECT j.id FROM jobs j JOIN hosting h ON h.user_id=j.user_id
        WHERE j.status='queued' AND j.date=? AND j.queue_published IN (0,1) AND j.available_at<=?
        AND j.dispatch_until<=? AND h.enabled=1 AND h.credential_state='valid'
        AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=j.user_id AND other.lease_until>=?)
        ORDER BY j.available_at,j.created_at LIMIT ?
      ) RETURNING id,queue_token AS token`,
      token,
      now + 60_000,
      beijingDate(now),
      now,
      now,
      now,
      limit,
    ).all<QueueMessage>();
    return rows.results;
  }
  async markDispatched(token: string) {
    // Delivery may have already claimed or finished the task. Never change that new state.
    // Reconcile an unclaimed message after one hour, including an exhausted dead-letter delivery.
    await this.sql(
      "UPDATE jobs SET queue_published=1,dispatch_until=? WHERE queue_token=? AND status='queued'",
      this.now() + 3600_000,
      token,
    ).run();
  }
  async claimQueued(message: QueueMessage): Promise<Job | null> {
    const now = this.now();
    const lease = crypto.randomUUID();
    const row = await this.sql(
      `UPDATE jobs SET status='running',attempts=attempts+1,lease=?,lease_until=?,updated_at=?,
      version=(SELECT version FROM hosting WHERE user_id=jobs.user_id)
      WHERE id=? AND queue_token=? AND status='queued' AND attempts<3 AND available_at<=? AND date=?
      AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND enabled=1 AND credential_state='valid')
      AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=jobs.user_id AND other.lease_until>=?) RETURNING *`,
      lease,
      now + 300_000,
      now,
      message.id,
      message.token,
      now,
      beijingDate(now),
      now,
    ).first<JobRow>();
    if (!row) return null;
    const credential = await this.sql(
      "SELECT heybox_id AS account,version,ciphertext FROM hosting WHERE user_id=? AND version=? AND credential_state='valid'",
      row.user_id,
      row.version,
    ).first<Credential>();
    return credential ? { id: row.id, date: row.date, lease, credential } : null;
  }
  async deadLetter(message: QueueMessage) {
    // Transport retries are not business attempts, including a failed handback during a pause.
    // D1 still bounds actual execution to three attempts; retry delivery with a short backoff.
    await this.deferQueued(message, 60_000);
  }
  async deferQueued(message: QueueMessage, delayMs = 0) {
    // The D1 job remains the durable source of work; an old delivery cannot reset a new one.
    await this.sql(
      `UPDATE jobs SET queue_token=NULL,queue_published=0,dispatch_until=?
       WHERE id=? AND queue_token=? AND status='queued'`,
      this.now() + delayMs,
      message.id,
      message.token,
    ).run();
  }
  async claim(): Promise<Job | null> {
    if ((await this.nextWorkAt()) > this.now()) return null;
    await this.recover();
    const now = this.now();
    const lease = crypto.randomUUID();
    const row = await this.sql(
      `UPDATE jobs SET status='running',attempts=attempts+1,lease=?,lease_until=?,updated_at=?,
      version=(SELECT version FROM hosting WHERE user_id=jobs.user_id)
      WHERE id=(SELECT j.id FROM jobs j JOIN hosting h ON h.user_id=j.user_id
        WHERE j.status='queued' AND j.available_at<=? AND j.date=? AND h.enabled=1 AND h.credential_state='valid'
        AND NOT EXISTS(SELECT 1 FROM jobs other WHERE other.user_id=j.user_id AND other.lease_until>=?)
        ORDER BY j.available_at,j.created_at LIMIT 1) RETURNING *`,
      lease,
      now + 300_000,
      now,
      now,
      beijingDate(now),
      now,
    ).first<JobRow>();
    if (!row) {
      await this.nextWorkAt();
      return null;
    }
    const credential = await this.sql(
      "SELECT heybox_id AS account,version,ciphertext FROM hosting WHERE user_id=? AND version=? AND credential_state='valid'",
      row.user_id,
      row.version,
    ).first<Credential>();
    if (!credential) return null;
    return { id: row.id, date: row.date, lease, credential };
  }
  async heartbeat(id: string, lease: string, version: string) {
    const now = this.now();
    const active = await this.sql(
      `SELECT lease_until FROM jobs WHERE id=? AND lease=? AND version=? AND status='running' AND lease_until>=? AND date=?
      AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND version=? AND credential_state='valid')`,
      id,
      lease,
      version,
      now,
      beijingDate(now),
      version,
    ).first<{ lease_until: number }>();
    if (!active) return false;
    if (active.lease_until - now >= 120_000) return true;
    // Recheck revocation atomically: a relogin or deletion may happen after the read.
    return !!(await this.sql(
      `UPDATE jobs SET lease_until=? WHERE id=? AND lease=? AND version=? AND status='running' AND lease_until>=? AND date=?
      AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND version=? AND credential_state='valid') RETURNING id`,
      now + 300_000,
      id,
      lease,
      version,
      now,
      beijingDate(now),
      version,
    ).first());
  }
  async finish(id: string, lease: string, version: string, outcome: Outcome) {
    const now = this.now();
    // A revoked child acknowledges that it has stopped; its result cannot change the new credential or job outcome.
    const released = await this.sql(
      `UPDATE jobs SET lease=NULL,lease_until=NULL,available_at=MIN(available_at,?)
      WHERE id=? AND lease=? AND version=? AND status IN ('queued','cancelled') AND lease_until IS NOT NULL RETURNING id`,
      now,
      id,
      lease,
      version,
    ).first();
    if (released) return false;
    const previous = await this.sql(
      `SELECT result FROM jobs WHERE id=? AND lease=? AND version=? AND status='running'`,
      id,
      lease,
      version,
    ).first<{ result: string | null }>();
    const old = previous?.result ? outcomeSchema.parse(JSON.parse(previous.result)) : null;
    const uncertain = outcome.uncertain || old?.uncertain || undefined;
    const execution =
      outcome.execution || old?.execution ? { ...old?.execution, ...outcome.execution } : undefined;
    if (execution) {
      for (const task of taskIds) {
        if (old?.execution?.[task] === "executed" || outcome.execution?.[task] === "executed")
          execution[task] = "executed";
        else if (
          uncertain || (old && old.execution?.[task] !== "skipped") ||
          outcome.execution?.[task] !== "skipped"
        )
          delete execution[task];
      }
    }
    const result = {
      ...outcome,
      uncertain,
      execution,
      batteryDelta:
        uncertain || outcome.batteryDelta === undefined || (old !== null && old.batteryDelta === undefined)
          ? undefined
          : outcome.batteryDelta + (old?.batteryDelta || 0),
      expDelta:
        uncertain || outcome.expDelta === undefined || (old !== null && old.expDelta === undefined)
          ? undefined
          : outcome.expDelta + (old?.expDelta || 0),
      coinDelta:
        uncertain || (outcome.coinDelta === undefined && old?.coinDelta === undefined)
          ? undefined
          : (outcome.coinDelta || 0) + (old?.coinDelta || 0),
    };
    // Both statements share one D1 transaction. The second can only disable the credential version that actually ran.
    await this.db.batch([
      this.sql(
        `UPDATE jobs SET status=CASE WHEN ?='failed' AND attempts<3
        AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND enabled=1) THEN 'queued' ELSE ? END,
        available_at=? + attempts*60000,result=?,updated_at=?,lease_until=NULL,
        queue_token=NULL,queue_published=0,dispatch_until=0 WHERE id=? AND lease=? AND version=? AND status='running'
        AND lease_until>=? AND date=? AND EXISTS(SELECT 1 FROM hosting WHERE user_id=jobs.user_id AND version=? AND credential_state='valid')`,
        outcome.status,
        outcome.status,
        now,
        JSON.stringify(result),
        now,
        id,
        lease,
        version,
        now,
        beijingDate(now),
        version,
      ),
      this.sql(
        `UPDATE hosting SET enabled=0,credential_state='expired',updated_at=? WHERE version=? AND user_id=(
        SELECT user_id FROM jobs WHERE id=? AND lease=? AND version=? AND status='auth_expired' AND updated_at=?)`,
        now,
        version,
        id,
        lease,
        version,
        now,
      ),
      ...(outcome.profile
        ? [
            this.sql(
              `UPDATE user SET name=COALESCE(?,name),image=COALESCE(?,image),updated_at=? WHERE id=(
          SELECT user_id FROM jobs WHERE id=? AND lease=? AND version=? AND status='completed' AND updated_at=?)`,
              outcome.profile.nickname || null,
              outcome.profile.avatar || null,
              now,
              id,
              lease,
              version,
              now,
            ),
          ]
        : []),
    ]);
    return !!(await this.sql(
      "SELECT id FROM jobs WHERE id=? AND lease=? AND version=? AND updated_at=? AND status<>'running'",
      id,
      lease,
      version,
      now,
    ).first());
  }
  async setEnabled(userId: string, enabled: boolean) {
    const now = this.now();
    await this.db.batch([
      this.sql(
        `UPDATE hosting SET enabled=?,updated_at=? WHERE user_id=? AND credential_state='valid'`,
        enabled ? 1 : 0,
        now,
        userId,
      ),
      ...(enabled
        ? []
        : [
            this.sql(
              `UPDATE jobs SET status='cancelled',updated_at=? WHERE user_id=? AND status='queued'`,
              now,
              userId,
            ),
          ]),
    ]);
    if (enabled) await this.enqueue(userId, true);
  }
  async accountCount() {
    const row = await this.sql("SELECT COUNT(*) AS count FROM hosting").first<{ count: number }>();
    return row?.count ?? 0;
  }
  async deleteUser(userId: string) {
    await this.sql("DELETE FROM user WHERE id=?", userId).run();
  }
  async dashboard(userId: string, includeHistory = true) {
    const today = beijingDate(this.now());
    const [settings, rows] = await Promise.all([
      this.sql(
        `SELECT h.heybox_id AS account,h.enabled,h.credential_state AS credentialState,u.name AS nickname,u.image AS avatar
        FROM hosting h JOIN user u ON u.id=h.user_id WHERE h.user_id=?`,
        userId,
      ).first<{
        account: string;
        enabled: number;
        credentialState: string;
        nickname: string;
        avatar: string | null;
      }>(),
      this.sql(
        includeHistory
          ? "SELECT id,date,status,attempts,result,updated_at FROM jobs WHERE user_id=? ORDER BY date DESC LIMIT 15"
          : "SELECT id,date,status,attempts,result,updated_at FROM jobs WHERE user_id=? AND date=? LIMIT 1",
        userId,
        ...(includeHistory ? [] : [today]),
      ).all<JobRow>(),
    ]);
    if (!settings) return null;
    const history = rows.results.map((row) => ({
      id: row.id,
      date: row.date,
      status: row.status,
      attempts: row.attempts,
      updatedAt: row.updated_at,
      result: row.result ? outcomeSchema.parse(JSON.parse(row.result)) : null,
    }));
    return {
      account: settings.account,
      nickname: settings.nickname,
      avatar: settings.avatar,
      enabled: !!settings.enabled,
      credentialState: settings.credentialState,
      nextRunAt: settings.enabled ? nextRunAt(this.now()) : null,
      today: history.find((row) => row.date === today) || null,
      history: includeHistory ? history : [],
    };
  }
  async history(userId: string) {
    const dashboard = await this.dashboard(userId);
    if (!dashboard) return null;
    return {
      account: dashboard.account,
      nickname: dashboard.nickname,
      avatar: dashboard.avatar,
      records: dashboard.history.map((row) => ({
        ...row,
        taskType: "daily" as const,
        taskName: "每日任务",
      })),
    };
  }
  async quotaStates(keys: string[]) {
    if (!keys.length) return [];
    return (
      await this.sql(
        `SELECT key,count,expires_at AS retryAt FROM rate_limits WHERE key IN (${keys.map(() => "?").join(",")}) AND expires_at>?`,
        ...keys,
        this.now(),
      ).all<{ key: string; count: number; retryAt: number }>()
    ).results;
  }
  async quota(key: string, limit: number, windowMs: number) {
    const now = this.now();
    return !!(await this.sql(
      `INSERT INTO rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE
      SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END
      WHERE expires_at<=? OR count<? RETURNING key`,
      key,
      now + windowMs,
      now,
      now,
      now + windowMs,
      now,
      limit,
    ).first());
  }
  async quotas(rules: ReadonlyArray<{ key: string; limit: number; windowMs: number }>) {
    if (!rules.length) return null;
    const now = this.now();
    // Distinct keys, in evaluation order. Snapshot admission before writing so a
    // rejected rule leaves all later counters untouched, just like quota() calls.
    const { results } = await this.sql(
      `WITH rules(position,key,max_count,window_ms) AS (VALUES ${rules.map((_, i) => `(${i},?,?,?)`).join(",")}),
      admission AS MATERIALIZED (
        SELECT rules.*,rate_limits.key IS NULL OR expires_at<=? OR count<max_count AS allowed
        FROM rules LEFT JOIN rate_limits ON rate_limits.key=rules.key
      )
      INSERT INTO rate_limits(key,count,expires_at)
      SELECT key,1,?+window_ms FROM admission
      WHERE position<COALESCE((SELECT MIN(position) FROM admission WHERE NOT allowed),?)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
        expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
      RETURNING key`,
      ...rules.flatMap((rule) => [rule.key, rule.limit, rule.windowMs]),
      now,
      now,
      rules.length,
      now,
      now,
    ).all<{ key: string }>();
    const admitted = new Set(results.map((row) => row.key));
    const rejected = rules.findIndex((rule) => !admitted.has(rule.key));
    return rejected < 0 ? null : rejected;
  }
}
