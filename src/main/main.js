const { app, BrowserWindow, ipcMain, dialog, Notification, safeStorage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const db = require('./db');
const mail = require('./mail-service');
const ai = require('./ai-service');
const chatgptAuth = require('./chatgpt-auth');

const DEFAULTS = {
  theme: 'light', language: 'de', fontScale: 1, syncIntervalMinutes: 5,
  notifications: true, muteUntil: null, notifyAccountIds: [], notifyCategories: [],
  autoSortWithChatGPT: true, chatgptModel: ''
};
let mainWindow;
let autoSyncTimer;
let syncRunning = false;
let selectedAttachmentPaths = new Set();
let tokenRefreshPromise = null;

function userFiles() {
  const root = app.getPath('userData');
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    settings: path.join(root, 'settings.json'),
    secrets: path.join(root, 'secrets.enc')
  };
}

function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(userFiles().settings, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

function writeJsonAtomic(filePath, data) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

async function readSecrets() {
  const filePath = userFiles().secrets;
  if (!fs.existsSync(filePath)) return { accounts: {}, aiApiKey: '' };
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Der Windows-Schlüsselspeicher ist momentan nicht verfügbar. Zugangsdaten wurden nicht entschlüsselt.');
  const encrypted = fs.readFileSync(filePath);
  return JSON.parse(await safeStorage.decryptStringAsync(encrypted));
}

async function writeSecrets(secrets) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Der Windows-Schlüsselspeicher ist nicht verfügbar. LumenMail speichert Zugangsdaten nicht unverschlüsselt.');
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(secrets));
  fs.writeFileSync(userFiles().secrets, encrypted, { mode: 0o600 });
}

async function chatgptProfile() {
  const secrets = await readSecrets();
  let profile = secrets.chatgpt || null;
  if (!profile?.accessToken || !profile?.refreshToken) throw new Error('Verbinde zuerst dein ChatGPT-Konto in den Einstellungen.');
  if (Number(profile.expiresAt || 0) < Date.now() + 60_000) {
    if (!tokenRefreshPromise) {
      tokenRefreshPromise = chatgptAuth.refreshProfile(profile).then(async (updated) => {
        const latest = await readSecrets();
        latest.chatgpt = updated;
        await writeSecrets(latest);
        return updated;
      }).finally(() => { tokenRefreshPromise = null; });
    }
    profile = await tokenRefreshPromise;
  }
  const models = await chatgptAuth.getModels(profile.accessToken);
  if (!models.length) throw new Error('ChatGPT ist verbunden, aber es wurde kein verfügbares Modell gefunden. Prüfe die Nutzung in deinem ChatGPT-Konto.');
  const settings = readSettings();
  const model = models.find((item) => item.slug === settings.chatgptModel) || models[0];
  if (settings.chatgptModel !== model.slug) {
    settings.chatgptModel = model.slug;
    writeJsonAtomic(userFiles().settings, settings);
  }
  return { profile, models, model };
}

function publicChatGPT(profile, models = []) {
  return profile ? { connected: true, email: profile.email || '', models } : { connected: false, email: '', models: [] };
}

function publicAccounts(settings) {
  return Array.isArray(settings.accounts) ? settings.accounts : [];
}

function safeError(error) {
  const message = String(error?.message || 'Unbekannter Fehler').replace(/\s+/g, ' ').slice(0, 400);
  if (/authentication|auth failed|invalid credentials|login failed|535|invalid login/i.test(message)) {
    return 'Anmeldung fehlgeschlagen. Prüfe Benutzername, Passwort oder App-Passwort und die IMAP/SMTP-Freigabe beim Anbieter.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|connect/i.test(message)) {
    return 'Verbindung fehlgeschlagen. Prüfe Serveradresse, Port, Internetverbindung und TLS-Einstellung.';
  }
  return message;
}

function accountById(accountId) {
  const account = publicAccounts(readSettings()).find((item) => item.id === accountId);
  if (!account) throw new Error('Das E-Mail-Konto wurde nicht gefunden.');
  return account;
}

async function accountAndSecret(accountId) {
  const account = accountById(accountId);
  const secrets = await readSecrets();
  return { account, secret: secrets.accounts?.[accountId] || {} };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#f6f7fb',
    title: 'LumenMail',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function cleanAccount(input, current = {}) {
  const account = {
    id: current.id || input.id || randomUUID(),
    name: String(input.name || '').trim().slice(0, 100),
    email: String(input.email || '').trim().slice(0, 320),
    imapHost: String(input.imapHost || '').trim().slice(0, 255),
    imapPort: Number(input.imapPort) || 993,
    imapSecure: input.imapSecure !== false,
    smtpHost: String(input.smtpHost || '').trim().slice(0, 255),
    smtpPort: Number(input.smtpPort) || 465,
    smtpSecure: input.smtpSecure !== false,
    authMode: input.authMode === 'oauth2' ? 'oauth2' : 'password',
    username: String(input.username || input.email || '').trim().slice(0, 320)
  };
  if (!account.name || !/^\S+@\S+\.\S+$/.test(account.email)) throw new Error('Bitte gib einen Kontonamen und eine gültige E-Mail-Adresse ein.');
  if (!account.imapHost || !account.smtpHost) throw new Error('Bitte gib IMAP- und SMTP-Serveradressen ein.');
  if (!Number.isInteger(account.imapPort) || account.imapPort < 1 || account.imapPort > 65535 || !Number.isInteger(account.smtpPort) || account.smtpPort < 1 || account.smtpPort > 65535) {
    throw new Error('Die Serverports müssen zwischen 1 und 65535 liegen.');
  }
  return account;
}

async function notifyNewMail(account, items) {
  const settings = readSettings();
  if (!settings.notifications || (settings.muteUntil && new Date(settings.muteUntil).getTime() > Date.now())) return;
  const accountFilter = settings.notifyAccountIds || [];
  if (accountFilter.length && !accountFilter.includes(account.id)) return;
  const categoryFilter = settings.notifyCategories || [];
  const visible = categoryFilter.length ? items.filter((item) => categoryFilter.includes(item.category)) : items;
  if (!visible.length || !Notification.isSupported()) return;
  const title = visible.length === 1 ? `Neue E-Mail von ${visible[0].sender}` : `${visible.length} neue E-Mails`;
  new Notification({ title, body: visible.length === 1 ? visible[0].subject : `In ${account.name} sind neue Nachrichten eingegangen.`, silent: false }).show();
  mainWindow?.webContents.send('mail:new', { accountId: account.id, count: visible.length });
}

async function syncOne(account) {
  const { secret } = await accountAndSecret(account.id);
  const result = await mail.syncAccount(account, secret, (progress) => mainWindow?.webContents.send('mail:sync-progress', { ...progress, accountId: account.id }));
  const settings = readSettings();
  if (result.newlyArrived.length && settings.autoSortWithChatGPT) {
    try {
      const { profile, model } = await chatgptProfile();
      const items = result.newlyArrived.map(({ id }) => db.getMessage(id)).filter(Boolean);
      const labels = await ai.classify(items, profile.accessToken, model.slug);
      const allowed = new Set(['Arbeit', 'Schule', 'Privat', 'Werbung']);
      const byId = new Map(items.map((item) => [item.id, item]));
      for (const label of labels) {
        const previous = byId.get(label.id);
        if (previous && allowed.has(label.category)) db.setCategory(label.id, label.category, Boolean(label.important) || previous.important);
      }
    } catch (error) {
      mainWindow?.webContents.send('mail:sort-status', { accountId: account.id, error: safeError(error) });
    }
  }
  if (result.newlyArrived.length) await notifyNewMail(account, result.newlyArrived);
  return result;
}

async function syncAll(accountId = '') {
  if (syncRunning) return { busy: true, results: [] };
  syncRunning = true;
  const accounts = publicAccounts(readSettings()).filter((account) => !accountId || account.id === accountId);
  if (accountId && !accounts.length) { syncRunning = false; throw new Error('Das E-Mail-Konto wurde nicht gefunden.'); }
  const results = [];
  try {
    for (const account of accounts) {
      try { results.push({ ...(await syncOne(account)), accountName: account.name }); }
      catch (error) { results.push({ accountId: account.id, accountName: account.name, error: safeError(error) }); }
    }
    return { results };
  } finally { syncRunning = false; }
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', async () => {
    const settings = readSettings();
    const accounts = publicAccounts(settings);
    db.cacheAccounts(accounts);
    const secrets = await readSecrets();
    let connectedProfile = secrets.chatgpt || null;
    let models = [];
    if (connectedProfile?.accessToken) {
      try { ({ profile: connectedProfile, models } = await chatgptProfile()); }
      catch { /* The interface can still open and offer a reconnect or local sorting. */ }
    }
    return { settings: readSettings(), accounts, stats: db.stats(), chatgpt: publicChatGPT(connectedProfile, models), messages: db.listMessages({ folder: 'inbox' }) };
  });
  ipcMain.handle('chatgpt:connect', async () => {
    const settings = readSettings();
    const secrets = await readSecrets();
    if (!settings.chatgptHostId) {
      settings.chatgptHostId = `urn:uuid:${randomUUID()}`;
      writeJsonAtomic(userFiles().settings, settings);
    }
    const profile = await chatgptAuth.signIn({ hostId: settings.chatgptHostId, existingProfile: secrets.chatgpt || null });
    secrets.chatgpt = profile;
    await writeSecrets(secrets);
    try {
      const { models } = await chatgptProfile();
      return publicChatGPT(profile, models);
    } catch {
      return publicChatGPT(profile, []);
    }
  });
  ipcMain.handle('chatgpt:disconnect', async () => {
    const secrets = await readSecrets();
    let revokeConfirmed = true;
    try { if (secrets.chatgpt) await chatgptAuth.revokeProfile(secrets.chatgpt); }
    catch { revokeConfirmed = false; }
    delete secrets.chatgpt;
    await writeSecrets(secrets);
    return { connected: false, revokeConfirmed };
  });
  ipcMain.handle('chatgpt:usage', async () => {
    await shell.openExternal('https://chatgpt.com/settings/usage');
    return { ok: true };
  });
  ipcMain.handle('mail:list', (_event, options) => db.listMessages(options || {}));
  ipcMain.handle('mail:get', (_event, { id }) => db.getMessage(id));
  ipcMain.handle('mail:sync', async (_event, { accountId } = {}) => syncAll(accountId || ''));
  ipcMain.handle('mail:action', async (_event, { id, action, value } = {}) => {
    const message = db.getMessage(id);
    if (!message) throw new Error('Diese Nachricht ist nicht mehr verfügbar.');
    if (action === 'category' || action === 'important') {
      db.setCategory(id, action === 'category' ? value : message.category, action === 'important' ? !message.important : message.important);
      return { ok: true };
    }
    if (message.draft) throw new Error('Entwürfe können über „Entwürfe“ bearbeitet oder gelöscht werden.');
    if (String(message.mailbox).startsWith('local-sent-')) {
      if (action === 'delete') db.removeMessage(id);
      else if (action === 'read' || action === 'unread') db.updateFlags(id, action === 'read' ? ['\\Seen'] : []);
      else if (action === 'archive') db.setCategory(id, message.category, message.important);
      return { ok: true };
    }
    const { account, secret } = await accountAndSecret(message.account_id);
    if (action === 'delete' && message.folder === 'trash') {
      await mail.updateRemoteMessage(account, secret, message, 'permanentDelete');
      db.removeMessage(id);
      return { ok: true };
    }
    const response = await mail.updateRemoteMessage(account, secret, message, action);
    if (action === 'archive' || action === 'delete') db.removeMessage(id);
    else if (response.flags) db.updateFlags(id, response.flags);
    else if (action === 'flag') db.setCategory(id, message.category, true);
    else if (action === 'unflag') db.setCategory(id, message.category, false);
    return { ok: true };
  });
  ipcMain.handle('draft:save', (_event, draft) => ({ id: db.saveDraft(draft) }));
  ipcMain.handle('draft:get', (_event, { id }) => db.getDraft(id));
  ipcMain.handle('draft:delete', (_event, { id }) => { db.deleteDraft(id); return { ok: true }; });
  ipcMain.handle('mail:send', async (_event, { accountId, draft, attachmentPaths = [] }) => {
    const { account, secret } = await accountAndSecret(accountId);
    if (!String(draft?.to || '').trim()) throw new Error('Bitte gib mindestens einen Empfänger ein.');
    if (!Array.isArray(attachmentPaths) || attachmentPaths.length > 20) throw new Error('Bitte verwende höchstens 20 Anhänge.');
    const safePaths = attachmentPaths.map((filePath) => {
      const resolved = path.resolve(String(filePath));
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('Ein Anhang ist keine Datei oder größer als 25 MB.');
      return resolved;
    });
    return mail.sendMessage(account, secret, draft, safePaths);
  });
  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Anhänge auswählen', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Alle Dateien', extensions: ['*'] }] });
    if (result.canceled) return [];
    for (const filePath of result.filePaths) selectedAttachmentPaths.add(path.resolve(filePath));
    return result.filePaths.map((filePath) => ({ path: filePath, name: path.basename(filePath) }));
  });
  ipcMain.handle('files:save-attachment', async (_event, { id, index }) => {
    const message = db.getMessage(id);
    const attachment = message?.attachments?.[Number(index)];
    if (!attachment) throw new Error('Anhang nicht gefunden.');
    const result = await dialog.showSaveDialog(mainWindow, { defaultPath: attachment.filename || 'Anhang' });
    if (result.canceled || !result.filePath) return { canceled: true };
    mail.saveAttachment(attachment, result.filePath);
    return { ok: true, filePath: result.filePath };
  });
  ipcMain.handle('account:test', async (_event, input) => {
    const account = cleanAccount(input.account || input);
    const stored = await readSecrets();
    const old = stored.accounts?.[account.id] || {};
    const submitted = input.secret || {};
    const secret = {
      password: submitted.password || old.password || '',
      accessToken: submitted.accessToken || old.accessToken || '',
      username: account.username,
      authMode: account.authMode
    };
    return mail.testConnection(account, secret);
  });
  ipcMain.handle('account:save', async (_event, input) => {
    const settings = readSettings();
    const accounts = publicAccounts(settings);
    const raw = input.account || input;
    const current = accounts.find((item) => item.id === (raw.id || input.id));
    const account = cleanAccount(raw, current);
    const secrets = await readSecrets();
    const old = secrets.accounts?.[account.id] || {};
    const submitted = input.secret || {};
    const secret = {
      authMode: account.authMode,
      username: account.username,
      password: submitted.password || old.password || '',
      accessToken: submitted.accessToken || old.accessToken || ''
    };
    if (secret.authMode === 'password' && !secret.password) throw new Error('Bitte trage das Passwort oder App-Passwort dieses Kontos ein.');
    if (secret.authMode === 'oauth2' && !secret.accessToken) throw new Error('Bitte trage den OAuth2-Zugriffstoken dieses Kontos ein.');
    const updated = current ? accounts.map((item) => item.id === account.id ? account : item) : [...accounts, account];
    secrets.accounts = { ...(secrets.accounts || {}), [account.id]: secret };
    await writeSecrets(secrets);
    settings.accounts = updated;
    writeJsonAtomic(userFiles().settings, settings);
    db.cacheAccounts(updated);
    return { account, accounts: updated };
  });
  ipcMain.handle('account:delete', async (_event, { id }) => {
    const settings = readSettings();
    settings.accounts = publicAccounts(settings).filter((account) => account.id !== id);
    writeJsonAtomic(userFiles().settings, settings);
    const secrets = await readSecrets();
    delete secrets.accounts?.[id];
    await writeSecrets(secrets);
    db.deleteAccountData(id);
    db.cacheAccounts(settings.accounts);
    return { accounts: settings.accounts };
  });
  ipcMain.handle('settings:save', async (_event, update) => {
    const settings = readSettings();
    const allowed = ['theme', 'language', 'fontScale', 'syncIntervalMinutes', 'notifications', 'muteUntil', 'notifyAccountIds', 'notifyCategories', 'autoSortWithChatGPT', 'chatgptModel'];
    for (const key of allowed) if (key in update) settings[key] = update[key];
    settings.theme = settings.theme === 'dark' ? 'dark' : 'light';
    settings.language = settings.language === 'en' ? 'en' : 'de';
    settings.fontScale = Math.min(1.2, Math.max(0.9, Number(settings.fontScale) || 1));
    settings.syncIntervalMinutes = Math.max(1, Math.min(120, Number(settings.syncIntervalMinutes) || 5));
    writeJsonAtomic(userFiles().settings, settings);
    scheduleSync();
    return { settings };
  });
  ipcMain.handle('ai:action', async (_event, { action, messageId, text } = {}) => {
    const { profile, model } = await chatgptProfile();
    let content = String(text || '');
    if (messageId) {
      const message = db.getMessage(messageId);
      if (!message) throw new Error('Diese Nachricht ist nicht mehr verfügbar.');
      content = `Von: ${message.from_name} <${message.from_email}>\nBetreff: ${message.subject}\n\n${message.body}`;
    }
    if (!content.trim()) throw new Error('Es gibt keinen Text für diese KI-Aktion.');
    return { text: await ai.complete({ action, content, accessToken: profile.accessToken, model: model.slug }) };
  });
  ipcMain.handle('ai:chat', async (_event, { question, accountId = '', history = [] } = {}) => {
    const { profile, model } = await chatgptProfile();
    const text = String(question || '').trim();
    if (!text) throw new Error('Schreibe zuerst eine Nachricht an den Chat.');
    const shouldSort = /sortier|kategorisier|ordne.{0,20}(ein|kategorie)|sort.{0,20}(mail|nachricht|e-mail)/i.test(text);
    if (shouldSort) {
      const items = db.listMessages({ folder: 'inbox', accountId }).slice(0, 30);
      if (!items.length) return { text: 'Im ausgewählten Posteingang sind noch keine E-Mails zum Sortieren. Synchronisiere zuerst dein Konto.' };
      const labels = await ai.classify(items, profile.accessToken, model.slug);
      const allowed = new Set(['Arbeit', 'Schule', 'Privat', 'Werbung']);
      const byId = new Map(items.map((item) => [item.id, item]));
      let changed = 0;
      const counts = { Arbeit: 0, Schule: 0, Privat: 0, Werbung: 0 };
      for (const label of labels) {
        const previous = byId.get(label.id);
        if (!previous || !allowed.has(label.category)) continue;
        db.setCategory(label.id, label.category, Boolean(label.important) || previous.important);
        counts[label.category] += 1;
        changed += 1;
      }
      return { text: `Ich habe ${changed} E-Mail${changed === 1 ? '' : 's'} im lokalen Posteingang kategorisiert.\nArbeit: ${counts.Arbeit} · Schule: ${counts.Schule} · Privat: ${counts.Privat} · Werbung: ${counts.Werbung}`, sorted: changed };
    }
    const localMessages = db.listMessages({ folder: 'inbox', accountId }).slice(0, 18);
    return { text: await ai.chat({ question: text, messages: localMessages, history, accessToken: profile.accessToken, model: model.slug }) };
  });
}

function scheduleSync() {
  clearInterval(autoSyncTimer);
  const minutes = readSettings().syncIntervalMinutes;
  autoSyncTimer = setInterval(() => { syncAll().catch(() => {}); }, minutes * 60 * 1000);
}

app.whenReady().then(async () => {
  try {
    userFiles();
    await db.openDatabase();
    db.cacheAccounts(publicAccounts(readSettings()));
    registerIpc();
    createWindow();
    scheduleSync();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  } catch (error) {
    dialog.showErrorBox('LumenMail konnte nicht starten', safeError(error));
    app.quit();
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => clearInterval(autoSyncTimer));

// Keep external links out of the renderer. Account setup and messages use no remote HTML.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
});

