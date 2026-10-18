const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const { htmlToText } = require('html-to-text');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const MAX_ATTACHMENT_CACHE = 8 * 1024 * 1024;

function authFor(account, secret) {
  const user = secret.username || account.email;
  if (secret.authMode === 'oauth2') {
    if (!secret.accessToken) throw new Error('Bitte trage für dieses Konto ein OAuth2-Zugriffstoken ein.');
    return { user, accessToken: secret.accessToken };
  }
  if (!secret.password) throw new Error('Für dieses Konto ist noch kein Passwort oder App-Passwort hinterlegt.');
  return { user, pass: secret.password };
}

function imapClient(account, secret, verifyOnly = false) {
  const secure = account.imapSecure !== false;
  return new ImapFlow({
    host: account.imapHost,
    port: Number(account.imapPort) || (secure ? 993 : 143),
    secure,
    doSTARTTLS: secure ? undefined : true,
    auth: authFor(account, secret),
    logger: false,
    verifyOnly,
    connectionTimeout: 30000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
    maxLineLength: 2 * 1024 * 1024,
    maxLiteralSize: 16 * 1024 * 1024,
    maxResponseSize: 20 * 1024 * 1024
  });
}

function smtpTransportFor(account, secret) {
  const auth = authFor(account, secret);
  const secure = account.smtpSecure !== false;
  return nodemailer.createTransport({
    host: account.smtpHost,
    port: Number(account.smtpPort) || (secure ? 465 : 587),
    secure,
    requireTLS: !secure,
    auth: secret.authMode === 'oauth2'
      ? { type: 'oauth2', user: auth.user, accessToken: auth.accessToken }
      : { user: auth.user, pass: auth.pass },
    connectionTimeout: 30000,
    greetingTimeout: 15000,
    socketTimeout: 60000
  });
}

function classifyMailbox(box) {
  const special = String(box.specialUse || '').toLowerCase();
  const name = `${box.path || ''} ${box.name || ''}`.toLowerCase();
  if (special.includes('\\inbox') || String(box.path).toUpperCase() === 'INBOX') return 'inbox';
  if (special.includes('\\sent') || /(^|[\/. ])sent( |$|[\/.])|gesendet/.test(name)) return 'sent';
  if (special.includes('\\drafts') || /draft|entw[uü]rf/.test(name)) return 'drafts';
  if (special.includes('\\trash') || /trash|papierkorb|deleted items/.test(name)) return 'trash';
  if (special.includes('\\archive') || /archive|archiv/.test(name)) return 'archive';
  return 'archive';
}

function chooseFolder(mailboxes, kind, fallback) {
  const specialMap = { sent: '\\sent', drafts: '\\drafts', trash: '\\trash', archive: '\\archive' };
  return mailboxes.find((box) => String(box.specialUse || '').toLowerCase().includes(specialMap[kind] || '\\inbox'))?.path
    || mailboxes.find((box) => classifyMailbox(box) === kind)?.path
    || fallback;
}

function suggestCategory(subject, fromEmail, body) {
  const content = `${subject} ${fromEmail} ${body.slice(0, 1200)}`.toLowerCase();
  if (/unsubscribe|abmelden|rabatt|sale|newsletter|angebot|gutschein/.test(content)) return 'Werbung';
  if (/schule|unterricht|hausaufgabe|klasse|lehrer|school/.test(content)) return 'Schule';
  if (/rechnung|projekt|meeting|angebot|kunde|arbeit|vertrag|office|team/.test(content)) return 'Arbeit';
  if (/familie|geburtstag|urlaub|freund|privat/.test(content)) return 'Privat';
  return 'Privat';
}

async function parsedMessage(account, mailbox, folder, message) {
  const parsed = await simpleParser(message.source || Buffer.from(''));
  let body = parsed.text || '';
  if (!body && parsed.html) body = htmlToText(parsed.html, { wordwrap: 100, selectors: [{ selector: 'img', format: 'skip' }] });
  body = String(body).replace(/\u0000/g, '').trim();
  const sender = parsed.from?.value?.[0] || message.envelope?.from?.[0] || {};
  const recipients = (parsed.to?.value || message.envelope?.to || []).map((person) => person.address || '').filter(Boolean);
  const flags = Array.from(message.flags || []);
  let attachmentBytes = 0;
  const attachments = (parsed.attachments || []).map((attachment) => {
    const size = Number(attachment.size || attachment.content?.length || 0);
    const item = { filename: attachment.filename || 'Anhang', contentType: attachment.contentType || 'application/octet-stream', size };
    if (attachmentBytes + size <= MAX_ATTACHMENT_CACHE && attachment.content) {
      item.contentBase64 = attachment.content.toString('base64');
      attachmentBytes += size;
    }
    return item;
  });
  const subject = String(parsed.subject || message.envelope?.subject || '(Ohne Betreff)').slice(0, 998);
  const fromEmail = String(sender.address || '').slice(0, 320);
  const date = parsed.date || message.internalDate || message.envelope?.date || new Date();
  const category = suggestCategory(subject, fromEmail, body);
  const id = `${account.id}|${encodeURIComponent(mailbox)}|${message.uid}`;
  const old = db.getMessage(id);
  const important = old?.important ?? (flags.some((flag) => String(flag).toLowerCase() === '\\flagged') || /wichtig|urgent|dringend|frist|deadline/.test(`${subject} ${body.slice(0, 600)}`.toLowerCase()));
  return {
    id, account_id: account.id, mailbox, folder, uid: Number(message.uid), subject,
    from_name: String(sender.name || fromEmail || 'Unbekannt').slice(0, 320), from_email: fromEmail,
    to_json: JSON.stringify(recipients), date: new Date(date).toISOString(), body,
    snippet: body.replace(/\s+/g, ' ').slice(0, 240), flags_json: JSON.stringify(flags),
    category: old?.category || category, important: important ? 1 : 0, attachments_json: JSON.stringify(attachments),
    message_id: String(parsed.messageId || ''), updated_at: new Date().toISOString()
  };
}

async function testConnection(account, secret) {
  const client = imapClient(account, secret, true);
  try {
    await client.connect();
  } catch (error) {
    error.lumenMailStage = 'IMAP';
    throw error;
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
  const transport = smtpTransportFor(account, secret);
  try {
    await transport.verify();
  } catch (error) {
    error.lumenMailStage = 'SMTP';
    throw error;
  } finally {
    transport.close();
  }
  return { ok: true, imapServer: account.imapHost, smtpServer: account.smtpHost };
}

async function syncAccount(account, secret, onProgress) {
  const client = imapClient(account, secret);
  const newlyArrived = [];
  let synced = 0;
  try {
    await client.connect();
    const allMailboxes = await client.list({ listOnly: true });
    const folders = allMailboxes
      .filter((box) => box.path && !box.disabled && !/junk|spam|werbung/i.test(`${box.path} ${box.specialUse || ''}`))
      .slice(0, 30);
    for (let index = 0; index < folders.length; index++) {
      const box = folders[index];
      const folder = classifyMailbox(box);
      onProgress?.({ current: index + 1, total: folders.length, folder: box.name || box.path });
      const lock = await client.getMailboxLock(box.path, { readOnly: true });
      try {
        const exists = Number(client.mailbox?.exists || 0);
        if (!exists) continue;
        const start = Math.max(1, exists - 39);
        const items = [];
        for await (const message of client.fetch(`${start}:*`, { uid: true, flags: true, envelope: true, internalDate: true, source: true })) {
          if (!message.uid || !message.source) continue;
          const id = `${account.id}|${encodeURIComponent(box.path)}|${message.uid}`;
          const existedBefore = Boolean(db.getMessage(id));
          const row = await parsedMessage(account, box.path, folder, message);
          items.push(row);
          if (!existedBefore && folder === 'inbox' && !Array.from(message.flags || []).some((flag) => String(flag).toLowerCase() === '\\seen')) {
            newlyArrived.push({ id, subject: row.subject, sender: row.from_name, category: row.category });
          }
        }
        db.upsertMessages(items);
        synced += items.length;
      } finally { lock.release(); }
    }
    return { accountId: account.id, count: synced, newlyArrived };
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

async function withMailbox(account, secret, mailbox, callback) {
  const client = imapClient(account, secret);
  try {
    await client.connect();
    const boxes = await client.list({ listOnly: true });
    const lock = await client.getMailboxLock(mailbox);
    try { return await callback(client, boxes); }
    finally { lock.release(); }
  } finally { try { await client.logout(); } catch { client.close(); } }
}

async function updateRemoteMessage(account, secret, message, operation) {
  return withMailbox(account, secret, message.mailbox, async (client, boxes) => {
    const range = Number(message.uid);
    if (!range) throw new Error('Diese Nachricht besitzt keine Server-UID.');
    if (operation === 'read') await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
    if (operation === 'unread') await client.messageFlagsRemove(range, ['\\Seen'], { uid: true });
    if (operation === 'flag') await client.messageFlagsAdd(range, ['\\Flagged'], { uid: true });
    if (operation === 'unflag') await client.messageFlagsRemove(range, ['\\Flagged'], { uid: true });
    if (operation === 'archive' || operation === 'delete') {
      const destination = chooseFolder(boxes, operation === 'archive' ? 'archive' : 'trash', operation === 'archive' ? 'Archive' : 'Trash');
      if (destination === message.mailbox) throw new Error('Zielordner entspricht dem aktuellen Ordner.');
      await client.messageMove(range, destination, { uid: true });
      return { movedTo: destination, folder: operation === 'archive' ? 'archive' : 'trash' };
    }
    if (operation === 'permanentDelete') await client.messageDelete(range, { uid: true });
    return { flags: operation === 'read' ? ['\\Seen'] : operation === 'unread' ? [] : undefined };
  });
}

async function sendMessage(account, secret, draft, attachments) {
  const transport = smtpTransportFor(account, secret);
  try {
    const info = await transport.sendMail({
      from: { name: account.name || account.email, address: account.email },
      to: draft.to,
      cc: draft.cc || undefined,
      subject: draft.subject || '(Ohne Betreff)',
      text: draft.body || '',
      attachments: attachments.map((filePath) => ({ path: filePath }))
    });
    const date = new Date().toISOString();
    const to = String(draft.to).split(/[;,]/).map((value) => value.trim()).filter(Boolean);
    const row = {
      id: `local-sent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      account_id: account.id, mailbox: `local-sent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, folder: 'sent', uid: 0,
      subject: draft.subject || '(Ohne Betreff)', from_name: account.name || account.email, from_email: account.email,
      to_json: JSON.stringify(to), date, body: draft.body || '', snippet: String(draft.body || '').slice(0, 240),
      flags_json: JSON.stringify(['\\Seen']), category: 'Privat', important: 0,
      attachments_json: JSON.stringify(attachments.map((filePath) => ({ filename: path.basename(filePath), size: fs.statSync(filePath).size }))),
      message_id: info.messageId || '', updated_at: date
    };
    db.upsertMessages([row]);
    return { accepted: info.accepted?.length || 0, messageId: info.messageId || '' };
  } finally { transport.close(); }
}

function saveAttachment(attachment, targetPath) {
  if (!attachment?.contentBase64) throw new Error('Dieser Anhang wurde nicht lokal gespeichert. Bitte synchronisiere die Nachricht erneut.');
  const buffer = Buffer.from(attachment.contentBase64, 'base64');
  if (buffer.byteLength > 25 * 1024 * 1024) throw new Error('Der Anhang ist größer als das erlaubte lokale Speicherlimit von 25 MB.');
  fs.writeFileSync(targetPath, buffer, { flag: 'wx' });
}

module.exports = { testConnection, syncAccount, updateRemoteMessage, sendMessage, saveAttachment, chooseFolder };


