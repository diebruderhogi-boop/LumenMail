const initSqlJs = require('sql.js');
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let db;
let databasePath;

function bindValues(values) {
  if (!values || Array.isArray(values) || typeof values !== 'object') return values;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.startsWith(':') || key.startsWith('@') || key.startsWith('$') ? key : `@${key}`, value]));
}

function persist() {
  if (!db || !databasePath) return;
  const temporary = `${databasePath}.tmp`;
  fs.writeFileSync(temporary, Buffer.from(db.export()), { mode: 0o600 });
  try { fs.renameSync(temporary, databasePath); }
  catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    try { fs.unlinkSync(databasePath); } catch {}
    fs.renameSync(temporary, databasePath);
  }
}

function prepare(sql) { return db.prepare(sql); }

function rows(sql, values) {
  const statement = prepare(sql);
  const result = [];
  try {
    if (values && Object.keys(values).length) statement.bind(bindValues(values));
    while (statement.step()) result.push(statement.getAsObject());
  } finally { statement.free(); }
  return result;
}

function one(sql, values) { return rows(sql, values)[0] || null; }

function run(sql, values) {
  db.run(sql, bindValues(values));
  persist();
}

async function openDatabase() {
  if (db) return db;
  databasePath = path.join(app.getPath('userData'), 'lumenmail.sqlite');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const SQL = await initSqlJs({ locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file) });
  db = fs.existsSync(databasePath) ? new SQL.Database(new Uint8Array(fs.readFileSync(databasePath))) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      folder TEXT NOT NULL,
      uid INTEGER NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      from_email TEXT NOT NULL DEFAULT '',
      to_json TEXT NOT NULL DEFAULT '[]',
      date TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      flags_json TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT 'Privat',
      important INTEGER NOT NULL DEFAULT 0,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      message_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, mailbox, uid)
    );
    CREATE INDEX IF NOT EXISTS messages_folder_date ON messages(folder, date DESC);
    CREATE INDEX IF NOT EXISTS messages_account_folder_date ON messages(account_id, folder, date DESC);
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      to_text TEXT NOT NULL DEFAULT '',
      cc_text TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS drafts_updated ON drafts(updated_at DESC);
    CREATE TABLE IF NOT EXISTS message_labels (
      message_id TEXT PRIMARY KEY,
      category TEXT NOT NULL DEFAULT 'Privat',
      important INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS accounts_cache (id TEXT PRIMARY KEY, email TEXT, name TEXT);
  `);
  const draftColumns = rows('PRAGMA table_info(drafts)').map((column) => column.name);
  if (!draftColumns.includes('attachments_json')) db.exec("ALTER TABLE drafts ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
  persist();
  return db;
}

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function rowToMessage(row) {
  if (!row) return null;
  const flags = safeJson(row.flags_json, []);
  return {
    ...row,
    to: safeJson(row.to_json, []),
    flags,
    attachments: safeJson(row.attachments_json, []),
    important: Boolean(row.important),
    unread: !flags.some((flag) => String(flag).toLowerCase() === '\\seen')
  };
}

function upsertMessages(messages) {
  const statement = prepare(`INSERT INTO messages
    (id, account_id, mailbox, folder, uid, subject, from_name, from_email, to_json, date, body, snippet,
     flags_json, category, important, attachments_json, message_id, updated_at)
    VALUES (@id, @account_id, @mailbox, @folder, @uid, @subject, @from_name, @from_email, @to_json, @date, @body,
     @snippet, @flags_json, @category, @important, @attachments_json, @message_id, @updated_at)
    ON CONFLICT(account_id, mailbox, uid) DO UPDATE SET
      folder=excluded.folder, subject=excluded.subject, from_name=excluded.from_name, from_email=excluded.from_email,
      to_json=excluded.to_json, date=excluded.date, body=excluded.body, snippet=excluded.snippet,
      flags_json=excluded.flags_json, attachments_json=excluded.attachments_json, message_id=excluded.message_id,
      updated_at=excluded.updated_at`);
  try {
    db.run('BEGIN TRANSACTION');
    for (const item of messages) statement.run(bindValues(item));
    db.run('COMMIT');
  } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
  finally { statement.free(); }
  persist();
}

function listMessages({ folder = 'inbox', accountId = '', query = '', sort = 'date', category = '' } = {}) {
  const allowedSort = { date: 'date DESC', sender: 'from_name COLLATE NOCASE ASC', subject: 'subject COLLATE NOCASE ASC', category: 'category COLLATE NOCASE ASC' };
  const order = allowedSort[sort] || allowedSort.date;
  const where = [];
  const params = {};
  if (folder && folder !== 'all' && folder !== 'drafts') { where.push('folder = @folder'); params.folder = folder; }
  if (accountId) { where.push('account_id = @accountId'); params.accountId = accountId; }
  if (category) { where.push('category = @category'); params.category = category; }
  if (query.trim()) {
    where.push('(subject LIKE @query OR from_name LIKE @query OR from_email LIKE @query OR body LIKE @query)');
    params.query = `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`;
  }
  const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 500`;
  const result = rows(sql, params).map(rowToMessage);
  if (folder === 'drafts' || folder === 'all') {
    const drafts = rows(`SELECT d.*, a.email AS from_email, a.name AS from_name
      FROM drafts d LEFT JOIN accounts_cache a ON a.id=d.account_id ${accountId ? 'WHERE d.account_id=@accountId' : ''}
      ORDER BY d.updated_at DESC LIMIT 500`, accountId ? { accountId } : {});
    result.push(...drafts.map((draft) => ({
      id: draft.id, account_id: draft.account_id, mailbox: 'local-drafts', folder: 'drafts', uid: 0,
      subject: draft.subject || '(Ohne Betreff)', from_name: draft.from_name || '', from_email: draft.from_email || '',
      to: draft.to_text ? draft.to_text.split(',').map((value) => value.trim()) : [], date: draft.updated_at,
      body: draft.body, snippet: String(draft.body || '').slice(0, 160), flags: [], unread: false,
      attachments: safeJson(draft.attachments_json, []), draft: true, important: false, category: 'Privat'
    })));
  }
  return result;
}

function cacheAccounts(accounts) {
  const statement = prepare(`INSERT INTO accounts_cache(id,email,name) VALUES(@id,@email,@name)
    ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name`);
  try {
    db.run('BEGIN TRANSACTION');
    for (const account of accounts) statement.run(bindValues({ id: account.id, email: account.email, name: account.name }));
    db.run('COMMIT');
  } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
  finally { statement.free(); }
  persist();
}

function getMessage(id) { return rowToMessage(one('SELECT * FROM messages WHERE id = @id', { id })); }

function updateFlags(id, flags) { run('UPDATE messages SET flags_json=@flags, updated_at=@updated WHERE id=@id', { flags: JSON.stringify(flags), updated: new Date().toISOString(), id }); }

function setCategory(id, category, important) { run('UPDATE messages SET category=@category, important=@important, updated_at=@updated WHERE id=@id', { category, important: important ? 1 : 0, updated: new Date().toISOString(), id }); }

function moveMessage(id, folder, mailbox) { run('UPDATE messages SET folder=@folder, mailbox=@mailbox, updated_at=@updated WHERE id=@id', { folder, mailbox, updated: new Date().toISOString(), id }); }

function removeMessage(id) { run('DELETE FROM messages WHERE id=@id', { id }); }

function stats() {
  return one(`SELECT
    SUM(CASE WHEN folder='inbox' THEN 1 ELSE 0 END) AS total,
    SUM(CASE WHEN folder='inbox' AND instr(lower(flags_json), '\\seen')=0 THEN 1 ELSE 0 END) AS unread,
    SUM(CASE WHEN folder='inbox' AND important=1 THEN 1 ELSE 0 END) AS important
    FROM messages`) || { total: 0, unread: 0, important: 0 };
}

function saveDraft(draft) {
  const id = draft.id || `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const updatedAt = new Date().toISOString();
  run(`INSERT INTO drafts(id,account_id,to_text,cc_text,subject,body,attachments_json,updated_at)
    VALUES(@id,@account_id,@to_text,@cc_text,@subject,@body,@attachments_json,@updated_at)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,to_text=excluded.to_text,cc_text=excluded.cc_text,
    subject=excluded.subject,body=excluded.body,attachments_json=excluded.attachments_json,updated_at=excluded.updated_at`, {
    id, account_id: draft.accountId, to_text: draft.to || '', cc_text: draft.cc || '', subject: draft.subject || '',
    body: draft.body || '', attachments_json: JSON.stringify(draft.attachments || []), updated_at: updatedAt
  });
  return id;
}

function deleteDraft(id) { run('DELETE FROM drafts WHERE id=@id', { id }); }

function getDraft(id) {
  const row = one('SELECT * FROM drafts WHERE id=@id', { id });
  return row ? { id: row.id, accountId: row.account_id, to: row.to_text, cc: row.cc_text, subject: row.subject, body: row.body,
    attachments: safeJson(row.attachments_json, []) } : null;
}

function deleteAccountData(accountId) {
  db.run('BEGIN TRANSACTION');
  try {
    db.run('DELETE FROM messages WHERE account_id=@id', bindValues({ id: accountId }));
    db.run('DELETE FROM drafts WHERE account_id=@id', bindValues({ id: accountId }));
    db.run('DELETE FROM accounts_cache WHERE id=@id', bindValues({ id: accountId }));
    db.run('COMMIT');
  } catch (error) { try { db.run('ROLLBACK'); } catch {} throw error; }
  persist();
}

module.exports = { openDatabase, upsertMessages, listMessages, getMessage, updateFlags, setCategory, moveMessage, removeMessage, stats, saveDraft, deleteDraft, getDraft, deleteAccountData, cacheAccounts };

