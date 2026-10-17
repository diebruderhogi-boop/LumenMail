(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const state = {
    settings: {}, accounts: [], chatgpt: { connected: false, email: '', models: [] }, messages: [],
    folder: 'inbox', category: '', query: '', sort: 'date', accountId: '', selectedId: '', selectedIds: new Set(),
    compose: null, attachments: [], chatHistory: [], currentProvider: 'gmail', editingAccountId: '', syncBusy: false
  };

  const categoryClass = (category) => `cat-${['Arbeit', 'Schule', 'Privat', 'Werbung'].includes(category) ? category : 'Privat'}`;
  const avatarClass = (seed = '') => `avatar-${[...String(seed)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5}`;
  const initials = (name = '') => String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
  const dateShort = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    return date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString(state.settings.language === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString(state.settings.language === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: 'short' });
  };
  const dateLong = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(state.settings.language === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  };

  function toast(message, type = '') {
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    $('#toastRegion').append(item);
    setTimeout(() => item.remove(), 5200);
  }

  function errorMessage(error) { return String(error?.message || error || 'Etwas ist schiefgelaufen.'); }

  function applyAppearance() {
    document.body.classList.toggle('dark', state.settings.theme === 'dark');
    document.documentElement.style.fontSize = `${15 * (Number(state.settings.fontScale) || 1)}px`;
    document.documentElement.lang = state.settings.language === 'en' ? 'en' : 'de';
    if (state.settings.language === 'en') {
      const labels = { inbox: 'Inbox', all: 'All mail', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', trash: 'Trash', settings: 'Settings' };
      $$('[data-i18n]').forEach((element) => { if (labels[element.dataset.i18n]) element.textContent = labels[element.dataset.i18n]; });
      $('#currentFolderTitle').textContent = ({ inbox: 'Inbox', all: 'All mail', sent: 'Sent', drafts: 'Drafts', archive: 'Archive', trash: 'Trash' })[state.folder] || state.category;
      $('#searchInput').placeholder = 'Search emails …';
      $('#composeBtn').lastChild.textContent = ' New email';
      $('#settingsBtn span:nth-child(2)').textContent = 'Settings';
    } else {
      const labels = { inbox: 'Posteingang', all: 'Alle E-Mails', sent: 'Gesendet', drafts: 'Entwürfe', archive: 'Archiv', trash: 'Papierkorb', settings: 'Einstellungen' };
      $$('[data-i18n]').forEach((element) => { if (labels[element.dataset.i18n]) element.textContent = labels[element.dataset.i18n]; });
      $('#currentFolderTitle').textContent = ({ inbox: 'Posteingang', all: 'Alle E-Mails', sent: 'Gesendet', drafts: 'Entwürfe', archive: 'Archiv', trash: 'Papierkorb' })[state.folder] || state.category;
      $('#searchInput').placeholder = 'E-Mails durchsuchen …';
      $('#composeBtn').lastChild.textContent = ' Neue E-Mail';
    }
  }

  function updateAccountSelects() {
    const top = $('#accountFilter');
    const previous = state.accountId;
    top.innerHTML = `<option value="">${state.settings.language === 'en' ? 'All accounts' : 'Alle Konten'}</option>` + state.accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} · ${escapeHtml(account.email)}</option>`).join('');
    top.value = state.accounts.some((account) => account.id === previous) ? previous : '';
    state.accountId = top.value;
    const compose = $('#composeAccount');
    compose.innerHTML = state.accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)} · ${escapeHtml(account.email)}</option>`).join('');
    $('#statAccounts').textContent = String(state.accounts.length);
    const selected = state.accounts.find((account) => account.id === state.accountId);
    $('#connectionTitle').textContent = selected?.name || (state.accounts.length ? `${state.accounts.length} verbundene Konten` : 'Noch kein Konto');
    $('#connectionSubtitle').textContent = selected?.email || (state.accounts.length ? 'Synchronisierung aktiv' : 'Füge ein Postfach hinzu');
    $('.connection-dot').classList.toggle('connected', state.accounts.length > 0);
  }

  function filteredMessages() {
    return state.messages.filter((message) => {
      if (state.folder !== 'all' && message.folder !== state.folder) return false;
      if (state.accountId && message.account_id !== state.accountId) return false;
      if (state.category === 'Wichtig' && !message.important) return false;
      if (state.category && state.category !== 'Wichtig' && message.category !== state.category) return false;
      const query = state.query.toLocaleLowerCase();
      if (query && ![message.subject, message.from_name, message.from_email, message.body, message.snippet].some((part) => String(part || '').toLocaleLowerCase().includes(query))) return false;
      return true;
    }).sort((a, b) => {
      if (state.sort === 'sender') return String(a.from_name).localeCompare(String(b.from_name));
      if (state.sort === 'subject') return String(a.subject).localeCompare(String(b.subject));
      if (state.sort === 'category') return String(a.category).localeCompare(String(b.category));
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  }

  function setFolder(folder) {
    state.folder = folder;
    state.category = '';
    state.selectedIds.clear();
    state.selectedId = '';
    $$('.nav-item[data-folder]').forEach((item) => item.classList.toggle('active', item.dataset.folder === folder));
    $$('.category-item').forEach((item) => item.classList.remove('active'));
    applyAppearance();
    renderList();
    showPreviewPlaceholder();
  }

  async function loadMessages() {
    state.messages = await window.lumen.listMessages({ folder: 'all', accountId: state.accountId, query: state.query, sort: state.sort });
    updateCounts();
    renderList();
    renderSettingsAccounts();
  }

  function updateCounts() {
    const inbox = state.messages.filter((item) => item.folder === 'inbox');
    const unread = inbox.filter((item) => item.unread).length;
    $('#unreadCount').textContent = unread > 99 ? '99+' : String(unread);
    $('#unreadCount').classList.toggle('hidden', unread === 0);
    $('#statUnread').textContent = String(unread);
    $('#statImportant').textContent = String(inbox.filter((item) => item.important).length);
    $('#draftCount').textContent = state.messages.filter((item) => item.draft).length || '';
  }

  function renderList() {
    applyAppearance();
    const items = filteredMessages();
    const list = $('#mailList');
    const allSelected = items.length && items.every((item) => state.selectedIds.has(item.id));
    $('#selectAllBtn').textContent = allSelected ? '☑' : '□';
    $('#selectionLabel').textContent = state.selectedIds.size ? `${state.selectedIds.size} ausgewählt` : '';
    $('#folderTotal').textContent = String(items.length);
    $('#listFooter').textContent = items.length ? `${items.length} ${items.length === 1 ? 'Nachricht' : 'Nachrichten'}` : '';
    const welcome = state.folder === 'inbox' && !state.query && !state.category;
    $('#welcomeStrip').classList.toggle('hidden', !welcome);
    $('#emptyState').classList.toggle('hidden', items.length > 0);
    list.classList.toggle('hidden', items.length === 0);
    if (!items.length) {
      const noAccounts = !state.accounts.length;
      $('#emptyTitle').textContent = noAccounts ? 'Dein Posteingang ist bereit' : 'Hier ist es gerade ganz ruhig';
      $('#emptyText').textContent = noAccounts ? 'Füge ein Konto hinzu und synchronisiere deine E-Mails.' : 'Für diese Ansicht wurden keine E-Mails gefunden. Synchronisiere dein Postfach oder ändere den Filter.';
      $('#emptyAction').textContent = noAccounts ? 'E-Mail-Konto hinzufügen' : 'Jetzt synchronisieren';
    }
    list.innerHTML = items.map((message) => {
      const checked = state.selectedIds.has(message.id);
      const account = state.accounts.find((item) => item.id === message.account_id);
      const category = ['Arbeit', 'Schule', 'Privat', 'Werbung'].includes(message.category) ? message.category : 'Privat';
      return `<article class="mail-row ${message.unread ? 'unread' : ''} ${message.id === state.selectedId ? 'selected' : ''}" data-message-id="${escapeHtml(message.id)}" role="listitem">
        <input class="row-check" type="checkbox" data-select-id="${escapeHtml(message.id)}" aria-label="Nachricht auswählen" ${checked ? 'checked' : ''}>
        <div class="sender-avatar ${avatarClass(message.from_email)}">${escapeHtml(initials(message.from_name || message.from_email))}</div>
        <div class="row-content"><div class="row-topline"><span class="row-sender">${escapeHtml(message.from_name || message.from_email || account?.name || 'Unbekannt')}</span><span class="row-date">${escapeHtml(dateShort(message.date))}</span></div><div class="row-subject-line"><span class="row-subject">${escapeHtml(message.subject || '(Ohne Betreff)')}</span></div><div class="row-snippet">${escapeHtml(message.snippet || '')}</div></div>
        <div class="row-meta">${message.important ? '<span class="important-star" title="Wichtig">★</span>' : ''}${message.attachments?.length ? '<span class="row-clip" title="Anhang vorhanden">⌁</span>' : ''}${message.draft ? '<span class="category-badge cat-Privat">Entwurf</span>' : `<select class="category-badge ${categoryClass(category)}" data-category-id="${escapeHtml(message.id)}" aria-label="Kategorie"><option ${category === 'Arbeit' ? 'selected' : ''}>Arbeit</option><option ${category === 'Schule' ? 'selected' : ''}>Schule</option><option ${category === 'Privat' ? 'selected' : ''}>Privat</option><option ${category === 'Werbung' ? 'selected' : ''}>Werbung</option></select>`}</div>
      </article>`;
    }).join('');
  }

  function showPreviewPlaceholder() {
    $('#previewPane').innerHTML = `<div class="preview-placeholder"><div class="preview-art">✦</div><h2>Dein Postfach, ganz entspannt.</h2><p>Wähle eine E-Mail aus, um sie hier zu lesen. Deine Nachrichten bleiben lokal gespeichert.</p><button class="text-button" id="previewChatBtn">✧ Frag den ChatGPT-Assistenten</button></div>`;
    $('#previewChatBtn').addEventListener('click', openChat);
  }

  async function openMessage(id) {
    const item = state.messages.find((message) => message.id === id);
    if (!item) return;
    if (item.draft) return openComposer({ draftId: id });
    state.selectedId = id;
    renderList();
    const message = await window.lumen.getMessage(id);
    if (!message) return toast('Diese E-Mail wurde nicht gefunden.', 'error');
    $('#previewPane').innerHTML = `<div class="reader" data-reader-id="${escapeHtml(message.id)}">
      <div class="reader-toolbar"><button class="toolbar-button" data-reader-action="archive" title="Archivieren">▱</button><button class="toolbar-button" data-reader-action="delete" title="Löschen">⌫</button><button class="toolbar-button" data-reader-action="${message.unread ? 'read' : 'unread'}" title="${message.unread ? 'Als gelesen markieren' : 'Als ungelesen markieren'}">${message.unread ? '✓' : '◉'}</button><span class="reader-actions-spacer"></span><button class="toolbar-button" data-reader-ai="summary" title="Zusammenfassen">✧</button><button class="toolbar-button" data-reader-ai="tasks" title="Aufgaben erkennen">☷</button></div>
      <div class="reader-head"><h2>${escapeHtml(message.subject || '(Ohne Betreff)')}</h2><div class="reader-sender"><div class="sender-avatar ${avatarClass(message.from_email)}">${escapeHtml(initials(message.from_name))}</div><div class="reader-sender-info"><b>${escapeHtml(message.from_name || message.from_email)}</b><small>${escapeHtml(message.from_email)}</small></div><span class="reader-time">${escapeHtml(dateLong(message.date))}</span></div><div class="reader-to">An: ${escapeHtml((message.to || []).join(', ') || 'dein Postfach')}</div></div>
      <div class="reader-body">${escapeHtml(message.body || '(Diese Nachricht enthält keinen Text.)')}</div>
      ${message.attachments?.length ? `<div class="reader-attachments">${message.attachments.map((attachment, index) => `<div class="attachment-chip"><span>⌁</span><span>${escapeHtml(attachment.filename)} · ${escapeHtml(formatBytes(attachment.size))}</span><button data-save-attachment="${index}">Speichern</button></div>`).join('')}</div>` : ''}
      <div class="ai-result hidden" id="readerAiResult"></div>
      <div class="reader-reply"><button class="button-quiet" data-reply="reply">↶ Antworten</button><button class="button-quiet" data-reply="forward">↗ Weiterleiten</button><span class="footer-spacer"></span><select class="category-badge reader-category ${categoryClass(message.category)}" data-reader-category aria-label="Kategorie"><option ${message.category === 'Arbeit' ? 'selected' : ''}>Arbeit</option><option ${message.category === 'Schule' ? 'selected' : ''}>Schule</option><option ${message.category === 'Privat' ? 'selected' : ''}>Privat</option><option ${message.category === 'Werbung' ? 'selected' : ''}>Werbung</option></select><button class="toolbar-button important-star" data-reader-important title="Wichtigkeit umschalten">${message.important ? '★' : '☆'}</button></div>
    </div>`;
    if (message.unread) {
      try { await window.lumen.action({ id, action: 'read' }); await loadMessages(); }
      catch (error) { toast(errorMessage(error), 'error'); }
    }
  }

  function formatBytes(value = 0) {
    const bytes = Number(value) || 0;
    return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function openComposer({ draftId = '', replyMessage = null, forwardMessage = null } = {}) {
    if (!state.accounts.length) { openAccountDialog(); return toast('Füge zuerst ein E-Mail-Konto hinzu.'); }
    state.compose = { draftId, accountId: state.accounts[0].id };
    state.attachments = [];
    $('#composeTitle').textContent = draftId ? 'Entwurf bearbeiten' : replyMessage ? 'Antwort schreiben' : forwardMessage ? 'E-Mail weiterleiten' : 'Neue E-Mail';
    $('#composeTo').value = '';
    $('#composeCc').value = '';
    $('#composeSubject').value = '';
    $('#composeBody').value = '';
    $('#composeStatus').textContent = '';
    $('#composeAttachments').innerHTML = '';
    $('#sendBtn').disabled = false;
    if (replyMessage) {
      state.compose.accountId = replyMessage.account_id;
      $('#composeTo').value = replyMessage.from_email;
      $('#composeSubject').value = /^re:/i.test(replyMessage.subject) ? replyMessage.subject : `Re: ${replyMessage.subject}`;
      $('#composeBody').value = `\n\n\nAm ${dateLong(replyMessage.date)} schrieb ${replyMessage.from_name}:\n> ${String(replyMessage.body || '').split('\n').slice(0, 30).join('\n> ')}`;
    }
    if (forwardMessage) {
      state.compose.accountId = forwardMessage.account_id;
      $('#composeSubject').value = /^fwd?:/i.test(forwardMessage.subject) ? forwardMessage.subject : `Fwd: ${forwardMessage.subject}`;
      $('#composeBody').value = `\n\n---------- Weitergeleitete Nachricht ----------\nVon: ${forwardMessage.from_name} <${forwardMessage.from_email}>\nBetreff: ${forwardMessage.subject}\nDatum: ${dateLong(forwardMessage.date)}\n\n${forwardMessage.body || ''}`;
    }
    $('#composeAccount').value = state.compose.accountId;
    if (draftId) {
      window.lumen.getDraft({ id: draftId }).then((draft) => {
        if (!draft) return;
        state.compose.accountId = draft.accountId;
        $('#composeAccount').value = draft.accountId;
        $('#composeTo').value = draft.to || '';
        $('#composeCc').value = draft.cc || '';
        $('#composeSubject').value = draft.subject || '';
        $('#composeBody').value = draft.body || '';
        state.attachments = (draft.attachments || []).filter((item) => item.path).map((item) => ({ path: item.path, name: item.name || item.filename || item.path.split(/[\\/]/).pop() }));
        renderComposeAttachments();
      }).catch((error) => toast(errorMessage(error), 'error'));
    }
    $('#composeDialog').showModal();
    $('#composeTo').focus();
  }

  function renderComposeAttachments() {
    $('#composeAttachments').innerHTML = state.attachments.map((item, index) => `<span class="attachment-chip">⌁ ${escapeHtml(item.name)} <button type="button" data-remove-compose-attachment="${index}" aria-label="Anhang entfernen">×</button></span>`).join('');
  }

  function composeDraft() {
    return {
      id: state.compose?.draftId || undefined,
      accountId: $('#composeAccount').value,
      to: $('#composeTo').value.trim(), cc: $('#composeCc').value.trim(),
      subject: $('#composeSubject').value.trim(), body: $('#composeBody').value,
      attachments: state.attachments.map((item) => ({ path: item.path, name: item.name }))
    };
  }

  async function saveDraft(close = false) {
    if (!state.accounts.length) return toast('Füge zuerst ein E-Mail-Konto hinzu.', 'error');
    try {
      const result = await window.lumen.saveDraft(composeDraft());
      state.compose.draftId = result.id;
      $('#composeStatus').textContent = 'Entwurf lokal gespeichert.';
      await loadMessages();
      if (close) $('#composeDialog').close();
      toast('Entwurf gespeichert.', 'success');
    } catch (error) { toast(errorMessage(error), 'error'); }
  }

  async function sendCurrentMessage() {
    const draft = composeDraft();
    if (!draft.to) { $('#composeTo').focus(); return toast('Bitte gib mindestens einen Empfänger ein.', 'error'); }
    $('#sendBtn').disabled = true;
    $('#composeStatus').textContent = 'E-Mail wird über deinen SMTP-Server gesendet …';
    try {
      await window.lumen.send({ accountId: draft.accountId, draft, attachmentPaths: state.attachments.map((item) => item.path) });
      if (state.compose?.draftId) await window.lumen.deleteDraft({ id: state.compose.draftId });
      $('#composeDialog').close();
      toast('E-Mail erfolgreich gesendet.', 'success');
      setFolder('sent');
      await loadMessages();
    } catch (error) { $('#composeStatus').textContent = errorMessage(error); toast(errorMessage(error), 'error'); }
    finally { $('#sendBtn').disabled = false; }
  }

  async function aiAction(action, { messageId = '', text = '' } = {}) {
    try { return await window.lumen.ai({ action, messageId, text }); }
    catch (error) { toast(errorMessage(error), 'error'); throw error; }
  }

  async function displayReaderAi(action) {
    const id = state.selectedId;
    if (!id) return;
    const result = $('#readerAiResult');
    if (!result) return;
    result.textContent = 'ChatGPT arbeitet an der Antwort …';
    result.classList.remove('hidden');
    try {
      const response = await aiAction(action, { messageId: id });
      result.textContent = response.text;
      result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch { result.classList.add('hidden'); }
  }

  function openChat() {
    $('#chatDrawer').classList.add('open');
    $('#chatInput').focus();
    updateChatConnection();
  }

  function updateChatConnection() {
    $('#chatConnectionLabel').textContent = state.chatgpt.connected ? `Verbunden als ${state.chatgpt.email || 'ChatGPT'}` : 'Postfach und E-Mails verstehen';
    $('#chatConnectCallout').classList.toggle('hidden', state.chatgpt.connected);
    $('#chatForm').classList.toggle('chat-needs-connection', !state.chatgpt.connected);
  }

  function addChatBubble(content, role, pending = false) {
    const welcome = $('.chat-welcome');
    if (welcome) welcome.remove();
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${role}${pending ? ' pending' : ''}`;
    bubble.textContent = content;
    $('#chatMessages').append(bubble);
    $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
    return bubble;
  }

  async function submitChat(question) {
    if (!question.trim()) return;
    $('#chatInput').value = '';
    addChatBubble(question, 'user');
    const pending = addChatBubble('Ich schaue in dein Postfach …', 'assistant', true);
    try {
      const response = await window.lumen.chat({ question, accountId: state.accountId, history: state.chatHistory.slice(-8) });
      pending.remove();
      addChatBubble(response.text, 'assistant');
      state.chatHistory.push({ role: 'user', content: question }, { role: 'assistant', content: response.text });
      await loadMessages();
    } catch (error) { pending.textContent = errorMessage(error); pending.classList.remove('pending'); pending.classList.add('error'); }
  }

  function openSettings(tab = 'general') {
    renderSettings();
    switchSettingsTab(tab);
    $('#settingsDialog').showModal();
  }

  function switchSettingsTab(tab) {
    $$('.settings-tab').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
    $$('.settings-section').forEach((section) => section.classList.toggle('active', section.dataset.settingsSection === tab));
  }

  function renderSettings() {
    $('#settingTheme').value = state.settings.theme || 'light';
    $('#settingLanguage').value = state.settings.language || 'de';
    $('#settingFont').value = String(state.settings.fontScale || 1);
    $('#settingSync').value = String(state.settings.syncIntervalMinutes || 5);
    $('#settingNotifications').checked = state.settings.notifications !== false;
    $('#settingAutoSort').checked = state.settings.autoSortWithChatGPT !== false;
    const muteMs = Math.max(0, new Date(state.settings.muteUntil || 0).getTime() - Date.now());
    $('#settingMute').value = muteMs >= 20 * 60 * 60 * 1000 ? '1440' : muteMs >= 6 * 60 * 60 * 1000 ? '480' : muteMs >= 30 * 60 * 1000 ? '60' : '0';
    $('#settingNotifyAccounts').innerHTML = state.accounts.map((account) => `<label><input type="checkbox" value="${escapeHtml(account.id)}" ${!state.settings.notifyAccountIds?.length || state.settings.notifyAccountIds.includes(account.id) ? 'checked' : ''}><span>${escapeHtml(account.name)}</span></label>`).join('') || '<small>Füge zuerst ein E-Mail-Konto hinzu.</small>';
    const noticeCategories = ['Arbeit', 'Schule', 'Privat', 'Werbung'];
    $('#settingNotifyCategories').innerHTML = noticeCategories.map((category) => `<label><input type="checkbox" value="${category}" ${!state.settings.notifyCategories?.length || state.settings.notifyCategories.includes(category) ? 'checked' : ''}><span>${category}</span></label>`).join('');
    renderSettingsAccounts();
    renderChatGPTSettings();
  }

  function renderSettingsAccounts() {
    const list = $('#settingsAccounts');
    if (!list) return;
    if (!state.accounts.length) { list.innerHTML = '<div class="empty-setting">Noch kein Konto hinzugefügt.</div>'; return; }
    list.innerHTML = state.accounts.map((account) => `<div class="saved-account"><div class="sender-avatar ${avatarClass(account.email)}">${escapeHtml(initials(account.name))}</div><div><b>${escapeHtml(account.name)}</b><small>${escapeHtml(account.email)} · ${escapeHtml(account.imapHost)}</small></div><span class="footer-spacer"></span><button class="button-quiet" data-edit-account="${escapeHtml(account.id)}">Bearbeiten</button><button class="button-quiet danger-text" data-delete-account="${escapeHtml(account.id)}">Entfernen</button></div>`).join('');
  }

  function renderChatGPTSettings() {
    const box = $('#chatgptConnection');
    if (state.chatgpt.connected) {
      box.innerHTML = `<div><b class="status-connected">● Verbunden</b><small>${escapeHtml(state.chatgpt.models?.length ? (state.chatgpt.email || 'ChatGPT-Konto verbunden') : 'Konto verbunden; prüfe die ChatGPT-Nutzung oder Modellfreigabe.')}</small></div><button type="button" class="button-quiet" id="disconnectChatGPTBtn">Trennen</button>`;
    } else {
      box.innerHTML = '<div><b class="status-disconnected">○ Nicht verbunden</b><small>Für Chat und KI-Sortierung anmelden.</small></div><button type="button" class="button-primary" id="connectChatGPTBtn">Mit ChatGPT verbinden</button>';
    }
    const model = $('#settingModel');
    const selected = state.settings.chatgptModel || '';
    model.innerHTML = '<option value="">Automatisch</option>' + (state.chatgpt.models || []).map((item) => `<option value="${escapeHtml(item.slug)}">${escapeHtml(item.displayName)}</option>`).join('');
    model.value = (state.chatgpt.models || []).some((item) => item.slug === selected) ? selected : '';
    updateChatConnection();
  }

  async function connectChatGPT() {
    $('#connectChatGPTBtn')?.setAttribute('disabled', 'disabled');
    toast('Der Browser öffnet die sichere ChatGPT-Anmeldung.');
    try {
      state.chatgpt = await window.lumen.connectChatGPT();
      toast(`ChatGPT ist verbunden${state.chatgpt.email ? `: ${state.chatgpt.email}` : ''}.`, 'success');
      renderChatGPTSettings();
      await loadMessages();
    } catch (error) { toast(errorMessage(error), 'error'); renderChatGPTSettings(); }
  }

  async function disconnectChatGPT() {
    if (!await askConfirm('ChatGPT trennen?', 'Die gespeicherte ChatGPT-Verbindung wird aus LumenMail gelöscht. E-Mail-Konten bleiben verbunden.')) return;
    try {
      const result = await window.lumen.disconnectChatGPT();
      state.chatgpt = { connected: false, email: '', models: [] };
      renderChatGPTSettings();
      toast(result.revokeConfirmed ? 'ChatGPT wurde getrennt.' : 'Lokale Tokens wurden gelöscht. Die Online-Abmeldung konnte nicht bestätigt werden.', result.revokeConfirmed ? 'success' : '');
    } catch (error) { toast(errorMessage(error), 'error'); }
  }

  function openAccountDialog(accountId = '') {
    state.editingAccountId = accountId;
    const account = state.accounts.find((item) => item.id === accountId);
    $('#accountForm').reset();
    $('#accountDialogTitle').textContent = account ? 'E-Mail-Konto bearbeiten' : 'E-Mail-Konto hinzufügen';
    $('#accountStatus').textContent = '';
    $('#accountName').value = account?.name || '';
    $('#accountEmail').value = account?.email || '';
    $('#accountUsername').value = account?.username || account?.email || '';
    $('#imapHost').value = account?.imapHost || '';
    $('#imapPort').value = account?.imapPort || 993;
    $('#smtpHost').value = account?.smtpHost || '';
    $('#smtpPort').value = account?.smtpPort || 465;
    $('#authMode').value = account?.authMode || 'password';
    $('#imapSecure').checked = account?.imapSecure !== false;
    $('#smtpSecure').checked = account?.smtpSecure !== false;
    $('#accountSecret').value = '';
    $('#accountSecret').required = !account;
    if (account) {
      state.currentProvider = account.imapHost.includes('gmail') ? 'gmail' : account.imapHost.includes('outlook') ? 'outlook' : account.imapHost.includes('t-online') ? 't-online' : account.imapHost.includes('mail.me.com') ? 'icloud' : 'custom';
      updateProviderUI();
      if (state.currentProvider === 't-online') $('#accountHelp').textContent = 'T‑Online: Verwende das „Passwort für E‑Mail‑Programme“ aus deinem Telekom-Konto. Die Anmeldung erfolgt hier nicht per QR-Code.';
      else if (state.currentProvider === 'icloud') $('#accountHelp').textContent = 'iCloud Mail: Verwende ein App-spezifisches Passwort von account.apple.com und deine vollständige @icloud.com-Adresse. Die Anmeldung erfolgt hier nicht per QR-Code.';
      else if (state.currentProvider === 'gmail') $('#accountHelp').textContent = 'Gmail: IMAP aktivieren und ein Google-App-Passwort verwenden. Das normale Google-Passwort wird hier nicht angenommen. Die Anmeldung erfolgt hier nicht per QR-Code.';
    } else {
      state.currentProvider = 'gmail';
      applyProviderPreset('gmail', true);
    }
    delete $('#accountUsername').dataset.touched;
    updateAuthField();
    $('#accountDialog').showModal();
  }

  function applyProviderPreset(provider, updateName = true) {
    const names = { gmail: 'Gmail', outlook: 'Outlook', 't-online': 'T-Online', icloud: 'iCloud', custom: '' };
    const previousName = names[state.currentProvider];
    const oldName = $('#accountName').value.trim();
    state.currentProvider = provider;
    if (provider === 'gmail') {
      $('#imapHost').value = 'imap.gmail.com'; $('#imapPort').value = '993'; $('#imapSecure').checked = true;
      $('#smtpHost').value = 'smtp.gmail.com'; $('#smtpPort').value = '465'; $('#smtpSecure').checked = true;
      $('#accountHelp').textContent = 'Gmail: IMAP aktivieren und ein Google-App-Passwort verwenden. Das normale Google-Passwort wird hier nicht angenommen. Die Anmeldung erfolgt hier nicht per QR-Code.';
    } else if (provider === 't-online') {
      $('#imapHost').value = 'secureimap.t-online.de'; $('#imapPort').value = '993'; $('#imapSecure').checked = true;
      $('#smtpHost').value = 'securesmtp.t-online.de'; $('#smtpPort').value = '465'; $('#smtpSecure').checked = true;
      $('#accountHelp').textContent = 'T‑Online: Verwende das „Passwort für E‑Mail‑Programme“ aus deinem Telekom-Konto. Die Serverdaten sind vorausgefüllt; die Anmeldung erfolgt hier nicht per QR-Code.';
    } else if (provider === 'icloud') {
      $('#imapHost').value = 'imap.mail.me.com'; $('#imapPort').value = '993'; $('#imapSecure').checked = true;
      $('#smtpHost').value = 'smtp.mail.me.com'; $('#smtpPort').value = '587'; $('#smtpSecure').checked = false;
      $('#accountHelp').textContent = 'iCloud Mail: Erstelle auf account.apple.com ein App-spezifisches Passwort. Trage deine vollständige @icloud.com-Adresse als Benutzernamen ein. Die Anmeldung erfolgt hier nicht per QR-Code.';
    } else if (provider === 'outlook') {
      $('#imapHost').value = 'outlook.office365.com'; $('#imapPort').value = '993'; $('#imapSecure').checked = true;
      $('#smtpHost').value = 'smtp.office365.com'; $('#smtpPort').value = '587'; $('#smtpSecure').checked = false;
      $('#accountHelp').textContent = 'Outlook / Microsoft 365: moderne Konten erfordern häufig OAuth2. Wähle OAuth2-Zugriffstoken und trage ein gültiges Token deines Anbieters ein; LumenMail bietet dafür noch keinen Microsoft-Anmeldeknopf.';
    } else {
      $('#accountHelp').textContent = 'Trage die IMAP- und SMTP-Serverdaten deines Anbieters ein. Die meisten Anbieter stellen sie in ihrer Hilfe bereit.';
    }
    if (updateName && (!oldName || oldName === previousName)) $('#accountName').value = names[provider];
    updateProviderUI();
  }

  function updateProviderUI() { $$('.provider-pill').forEach((button) => button.classList.toggle('active', button.dataset.provider === state.currentProvider)); }

  function updateAuthField() {
    const oauth = $('#authMode').value === 'oauth2';
    $('#accountSecretLabel').textContent = oauth ? 'OAuth2-Zugriffstoken' : 'Passwort oder App-Passwort';
    $('#accountSecret').placeholder = oauth ? 'Zugriffstoken einfügen' : 'Wird verschlüsselt gespeichert';
    $('#accountSecret').autocomplete = 'new-password';
    $('#accountSecret').required = !state.editingAccountId;
  }

  function accountFormValue() {
    return {
      id: state.editingAccountId || undefined,
      name: $('#accountName').value.trim(), email: $('#accountEmail').value.trim(),
      username: $('#accountUsername').value.trim(),
      imapHost: $('#imapHost').value.trim(), imapPort: Number($('#imapPort').value), imapSecure: $('#imapSecure').checked,
      smtpHost: $('#smtpHost').value.trim(), smtpPort: Number($('#smtpPort').value), smtpSecure: $('#smtpSecure').checked,
      authMode: $('#authMode').value
    };
  }

  function accountSecretValue() {
    const rawValue = $('#accountSecret').value;
    const value = state.currentProvider === 'gmail' && $('#authMode').value === 'password' ? rawValue.replace(/\s+/g, '') : rawValue;
    return $('#authMode').value === 'oauth2' ? { accessToken: value } : { password: value };
  }

  async function testAccount() {
    const button = $('#testAccountBtn'); button.disabled = true;
    $('#accountStatus').textContent = 'IMAP- und SMTP-Verbindung werden geprüft …';
    try {
      const result = await window.lumen.testAccount({ account: accountFormValue(), secret: accountSecretValue() });
      $('#accountStatus').textContent = `IMAP (${result.imapServer}) und SMTP (${result.smtpServer}) funktionieren.`;
      toast('Empfang und Versand funktionieren.', 'success');
    } catch (error) { $('#accountStatus').textContent = errorMessage(error); toast(errorMessage(error), 'error'); }
    finally { button.disabled = false; }
  }

  async function saveAccount() {
    const button = $('#saveAccountBtn'); button.disabled = true;
    $('#accountStatus').textContent = 'IMAP und SMTP werden geprüft …';
    try {
      const connection = await window.lumen.testAccount({ account: accountFormValue(), secret: accountSecretValue() });
      $('#accountStatus').textContent = 'Verbindung erfolgreich. Konto wird sicher gespeichert …';
      const result = await window.lumen.saveAccount({ account: accountFormValue(), secret: accountSecretValue() });
      state.accounts = result.accounts;
      $('#accountDialog').close();
      updateAccountSelects();
      renderSettingsAccounts();
      await loadMessages();
      toast(`Konto gespeichert. Empfang (${connection.imapServer}) und Versand (${connection.smtpServer}) funktionieren.`, 'success');
      await syncNow(result.account.id);
    } catch (error) { $('#accountStatus').textContent = errorMessage(error); toast(errorMessage(error), 'error'); }
    finally { button.disabled = false; }
  }

  async function deleteAccount(id) {
    const account = state.accounts.find((item) => item.id === id);
    if (!await askConfirm('Konto entfernen?', `„${account?.name || 'Dieses Konto'}“ und die lokal gespeicherten E-Mails und Entwürfe werden aus LumenMail entfernt. E-Mails auf dem Anbieter-Server bleiben unberührt.`)) return;
    try {
      const result = await window.lumen.deleteAccount({ id });
      state.accounts = result.accounts;
      state.accountId = '';
      updateAccountSelects();
      await loadMessages();
      showPreviewPlaceholder();
      toast('Konto und lokale Kopien entfernt.', 'success');
    } catch (error) { toast(errorMessage(error), 'error'); }
  }

  function askConfirm(title, description) {
    return new Promise((resolve) => {
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = description;
      const dialog = $('#confirmDialog');
      const onClose = () => { dialog.removeEventListener('close', onClose); resolve(dialog.returnValue === 'confirm'); };
      dialog.addEventListener('close', onClose);
      dialog.showModal();
    });
  }

  async function saveSettings() {
    const notifyAccountIds = $$('#settingNotifyAccounts input:checked').map((item) => item.value);
    const notifyCategories = $$('#settingNotifyCategories input:checked').map((item) => item.value);
    const update = {
      theme: $('#settingTheme').value, language: $('#settingLanguage').value,
      fontScale: Number($('#settingFont').value), syncIntervalMinutes: Number($('#settingSync').value),
      notifications: $('#settingNotifications').checked, autoSortWithChatGPT: $('#settingAutoSort').checked,
      chatgptModel: $('#settingModel').value,
      muteUntil: Number($('#settingMute').value) ? new Date(Date.now() + Number($('#settingMute').value) * 60_000).toISOString() : null,
      notifyAccountIds: notifyAccountIds.length === state.accounts.length ? [] : notifyAccountIds,
      notifyCategories: notifyCategories.length === 4 ? [] : notifyCategories
    };
    try {
      const response = await window.lumen.saveSettings(update);
      state.settings = response.settings;
      applyAppearance();
      $('#settingsDialog').close();
      await loadMessages();
      toast('Einstellungen gespeichert.', 'success');
    } catch (error) { toast(errorMessage(error), 'error'); }
  }

  async function syncNow(accountId = '') {
    if (!state.accounts.length) return toast('Füge zuerst ein E-Mail-Konto hinzu.');
    if (state.syncBusy) return;
    state.syncBusy = true;
    $('#syncBtn').classList.add('spinning');
    $('#syncBanner').classList.remove('hidden');
    $('#syncText').textContent = 'Postfach wird synchronisiert …';
    try {
      const result = await window.lumen.sync({ accountId });
      const failures = (result.results || []).filter((item) => item.error);
      const received = (result.results || []).reduce((sum, item) => sum + (item.newlyArrived?.length || 0), 0);
      if (failures.length) toast(failures.map((item) => `${item.accountName}: ${item.error}`).join('\n'), 'error');
      else if (received) toast(`${received} neue ${received === 1 ? 'E-Mail ist' : 'E-Mails sind'} eingegangen.`, 'success');
      else toast('Postfach synchronisiert.', 'success');
      await loadMessages();
      if (state.selectedId) await openMessage(state.selectedId);
    } catch (error) { toast(errorMessage(error), 'error'); }
    finally { state.syncBusy = false; $('#syncBtn').classList.remove('spinning'); $('#syncBanner').classList.add('hidden'); }
  }

  async function digestInbox() {
    if (!state.chatgpt.connected) { openSettings('chatgpt'); return toast('Verbinde zuerst dein ChatGPT-Konto.'); }
    const unread = state.messages.filter((item) => item.folder === 'inbox' && item.unread).slice(0, 15);
    const items = unread.length ? unread : state.messages.filter((item) => item.folder === 'inbox').slice(0, 12);
    if (!items.length) return toast('Synchronisiere zuerst deine E-Mails.');
    const content = items.map((item) => `Von: ${item.from_name} <${item.from_email}>\nBetreff: ${item.subject}\nDatum: ${dateLong(item.date)}\n\n${String(item.body || '').slice(0, 1500)}`).join('\n\n---\n\n');
    try {
      const result = await aiAction('digest', { text: content });
      const preview = $('#previewPane');
      preview.innerHTML = `<div class="digest-reader"><button class="text-button" id="digestBackBtn">← Zurück</button><div class="digest-icon">✧</div><span class="eyebrow">CHATGPT · POSTFACH-ÜBERBLICK</span><h2>Das Wichtigste in deinen E-Mails</h2><div class="digest-result">${escapeHtml(result.text)}</div><p class="digest-footnote">Erstellt aus ${items.length} ${items.length === 1 ? 'E-Mail' : 'E-Mails'}${unread.length ? ' (ungelesen)' : ''}. Nachrichteninhalte wurden für diese Anfrage an ChatGPT gesendet.</p></div>`;
      $('#digestBackBtn').addEventListener('click', showPreviewPlaceholder);
    } catch { /* error already shown */ }
  }

  async function runSelectedAction(action) {
    const ids = [...state.selectedIds];
    if (!ids.length) return toast('Wähle zuerst mindestens eine E-Mail aus.');
    try {
      for (const id of ids) {
        const message = state.messages.find((item) => item.id === id);
        if (message?.draft) {
          if (action === 'delete') await window.lumen.deleteDraft({ id });
          continue;
        }
        await window.lumen.action({ id, action });
      }
      state.selectedIds.clear();
      if (state.selectedId && ids.includes(state.selectedId)) { state.selectedId = ''; showPreviewPlaceholder(); }
      await loadMessages();
      toast(action === 'archive' ? 'E-Mails archiviert.' : action === 'delete' ? 'E-Mails in den Papierkorb verschoben.' : 'E-Mails als gelesen markiert.', 'success');
    } catch (error) { toast(errorMessage(error), 'error'); }
  }

  function bindEvents() {
    $('#composeBtn').addEventListener('click', () => openComposer());
    $('#settingsBtn').addEventListener('click', () => openSettings());
    $('#profileBtn').addEventListener('click', () => openAccountDialog());
    $('#chatOpenBtn').addEventListener('click', openChat);
    $('#previewChatBtn')?.addEventListener('click', openChat);
    $('#chatCloseBtn').addEventListener('click', () => $('#chatDrawer').classList.remove('open'));
    $('#chatSettingsBtn').addEventListener('click', () => openSettings('chatgpt'));
    $('#syncBtn').addEventListener('click', () => syncNow());
    $('#refreshListBtn').addEventListener('click', loadMessages);
    $('#emptyAction').addEventListener('click', () => state.accounts.length ? syncNow() : openAccountDialog());
    $('#accountFilter').addEventListener('change', async (event) => { state.accountId = event.target.value; await loadMessages(); });
    $('#searchInput').addEventListener('input', async (event) => { state.query = event.target.value; await loadMessages(); });
    $('#sortSelect').addEventListener('change', async (event) => { state.sort = event.target.value; await loadMessages(); });
    $('#selectAllBtn').addEventListener('click', () => {
      const items = filteredMessages();
      if (items.length && items.every((item) => state.selectedIds.has(item.id))) items.forEach((item) => state.selectedIds.delete(item.id));
      else items.forEach((item) => state.selectedIds.add(item.id));
      renderList();
    });
    $('#markReadBtn').addEventListener('click', () => runSelectedAction('read'));
    $('#archiveSelectedBtn').addEventListener('click', () => runSelectedAction('archive'));
    $('#deleteSelectedBtn').addEventListener('click', () => runSelectedAction('delete'));
    $$('.nav-item[data-folder]').forEach((button) => button.addEventListener('click', () => setFolder(button.dataset.folder)));
    $$('.category-item').forEach((button) => button.addEventListener('click', () => {
      state.category = button.dataset.category;
      state.selectedIds.clear();
      $$('.nav-item[data-folder]').forEach((item) => item.classList.remove('active'));
      $$('.category-item').forEach((item) => item.classList.toggle('active', item === button));
      $('#currentFolderTitle').textContent = state.category === 'Wichtig' ? 'Wichtige E-Mails' : state.category;
      renderList();
    }));

    $('#mailList').addEventListener('click', (event) => {
      if (event.target.closest('select, input')) return;
      const row = event.target.closest('.mail-row');
      if (row) openMessage(row.dataset.messageId);
    });
    $('#mailList').addEventListener('change', async (event) => {
      if (event.target.matches('[data-select-id]')) {
        const id = event.target.dataset.selectId;
        event.target.checked ? state.selectedIds.add(id) : state.selectedIds.delete(id);
        renderList();
      }
      if (event.target.matches('[data-category-id]')) {
        try { await window.lumen.action({ id: event.target.dataset.categoryId, action: 'category', value: event.target.value }); await loadMessages(); }
        catch (error) { toast(errorMessage(error), 'error'); }
      }
    });
    $('#previewPane').addEventListener('click', async (event) => {
      const root = event.target.closest('.reader');
      if (event.target.id === 'previewChatBtn') return openChat();
      if (event.target.closest('[data-reply]')) {
        const message = await window.lumen.getMessage(root?.dataset.readerId);
        if (message) openComposer(event.target.closest('[data-reply]').dataset.reply === 'reply' ? { replyMessage: message } : { forwardMessage: message });
      }
      const actionButton = event.target.closest('[data-reader-action]');
      if (actionButton && root) {
        try { await window.lumen.action({ id: root.dataset.readerId, action: actionButton.dataset.readerAction }); await loadMessages(); actionButton.dataset.readerAction === 'delete' || actionButton.dataset.readerAction === 'archive' ? showPreviewPlaceholder() : await openMessage(root.dataset.readerId); }
        catch (error) { toast(errorMessage(error), 'error'); }
      }
      const aiButton = event.target.closest('[data-reader-ai]');
      if (aiButton) displayReaderAi(aiButton.dataset.readerAi);
      if (event.target.closest('[data-reader-important]') && root) {
        try { await window.lumen.action({ id: root.dataset.readerId, action: 'important' }); await openMessage(root.dataset.readerId); await loadMessages(); }
        catch (error) { toast(errorMessage(error), 'error'); }
      }
      const saveButton = event.target.closest('[data-save-attachment]');
      if (saveButton && root) {
        try { const result = await window.lumen.saveAttachment({ id: root.dataset.readerId, index: Number(saveButton.dataset.saveAttachment) }); if (result.ok) toast(`Anhang gespeichert: ${result.filePath}`, 'success'); }
        catch (error) { toast(errorMessage(error), 'error'); }
      }
    });
    $('#previewPane').addEventListener('change', async (event) => {
      if (event.target.matches('[data-reader-category]')) {
        const id = event.target.closest('.reader').dataset.readerId;
        try { await window.lumen.action({ id, action: 'category', value: event.target.value }); await loadMessages(); }
        catch (error) { toast(errorMessage(error), 'error'); }
      }
    });

    $('#digestBtn').addEventListener('click', digestInbox);
    $('#composeForm').addEventListener('submit', (event) => event.preventDefault());
    $('#saveDraftBtn').addEventListener('click', () => saveDraft());
    $('#sendBtn').addEventListener('click', sendCurrentMessage);
    $('#attachBtn').addEventListener('click', async () => {
      try { state.attachments.push(...await window.lumen.pickAttachments()); renderComposeAttachments(); }
      catch (error) { toast(errorMessage(error), 'error'); }
    });
    $('#composeAttachments').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-compose-attachment]');
      if (!button) return;
      state.attachments.splice(Number(button.dataset.removeComposeAttachment), 1); renderComposeAttachments();
    });
    $$('[data-compose-ai]').forEach((button) => button.addEventListener('click', async () => {
      const original = $('#composeBody').value;
      if (!original.trim()) return toast('Schreibe zuerst einen Textentwurf.');
      button.disabled = true;
      try { const result = await aiAction(button.dataset.composeAi, { text: original }); $('#composeBody').value = result.text; }
      catch { /* toast is shown by aiAction */ }
      finally { button.disabled = false; }
    }));

    $$('.settings-tab').forEach((button) => button.addEventListener('click', () => switchSettingsTab(button.dataset.settingsTab)));
    $('#saveSettingsBtn').addEventListener('click', saveSettings);
    $('#addAccountBtn').addEventListener('click', () => openAccountDialog());
    $('#settingsAccounts').addEventListener('click', (event) => {
      const edit = event.target.closest('[data-edit-account]');
      const remove = event.target.closest('[data-delete-account]');
      if (edit) openAccountDialog(edit.dataset.editAccount);
      if (remove) deleteAccount(remove.dataset.deleteAccount);
    });
    $('#provider-pills')?.addEventListener('click', () => {});
    $$('.provider-pill').forEach((button) => button.addEventListener('click', () => applyProviderPreset(button.dataset.provider)));
    $('#authMode').addEventListener('change', updateAuthField);
    $('#accountEmail').addEventListener('input', () => { if (!$('#accountUsername').dataset.touched) $('#accountUsername').value = $('#accountEmail').value; });
    $('#accountUsername').addEventListener('input', () => { $('#accountUsername').dataset.touched = 'true'; });
    $('#testAccountBtn').addEventListener('click', testAccount);
    $('#saveAccountBtn').addEventListener('click', saveAccount);
    $('#connectChatGPTBtn')?.addEventListener('click', connectChatGPT);
    $('#disconnectChatGPTBtn')?.addEventListener('click', disconnectChatGPT);
    $('#privacyDisconnectBtn').addEventListener('click', disconnectChatGPT);
    $('#usageBtn').addEventListener('click', () => window.lumen.openChatGPTUsage().catch((error) => toast(errorMessage(error), 'error')));
    $('#chatgptConnection').addEventListener('click', (event) => {
      if (event.target.closest('#connectChatGPTBtn')) connectChatGPT();
      if (event.target.closest('#disconnectChatGPTBtn')) disconnectChatGPT();
    });
    $('#chatForm').addEventListener('submit', (event) => { event.preventDefault(); submitChat($('#chatInput').value); });
    $('#chatMessages').addEventListener('click', (event) => {
      const chip = event.target.closest('[data-chat-prompt]');
      if (chip) submitChat(chip.dataset.chatPrompt);
    });
    $('#chatInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#chatForm').requestSubmit(); }
    });
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#searchInput').focus(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); openComposer(); }
      if (event.key === 'Escape') $('#chatDrawer').classList.remove('open');
    });

    window.lumen.onSync((progress) => {
      $('#syncBanner').classList.remove('hidden');
      $('#syncText').textContent = `${progress.folder || 'Postfach'} wird synchronisiert (${progress.current}/${progress.total}) …`;
    });
    window.lumen.onNewMail((data) => {
      toast(data.count === 1 ? 'Eine neue E-Mail ist eingegangen.' : `${data.count} neue E-Mails sind eingegangen.`, 'success');
      loadMessages();
    });
    window.lumen.onSortStatus((data) => { if (data.error) toast(`Automatische ChatGPT-Sortierung: ${data.error}`); });
  }

  async function init() {
    try {
      const bootstrap = await window.lumen.bootstrap();
      state.settings = bootstrap.settings || {};
      state.accounts = bootstrap.accounts || [];
      state.chatgpt = bootstrap.chatgpt || { connected: false, email: '', models: [] };
      applyAppearance();
      updateAccountSelects();
      bindEvents();
      await loadMessages();
      if (state.accounts.length) $('#welcomeSubtitle').textContent = 'Dein Postfach ist bereit. Synchronisiere, um neue E-Mails abzurufen.';
      if (bootstrap.secretsRecoveryWarning) {
        toast(bootstrap.secretsRecoveryWarning, 'error');
        if (state.accounts.length) setTimeout(() => openAccountDialog(state.accounts[0].id), 500);
        else setTimeout(() => openSettings('chatgpt'), 500);
      }
      if (!state.accounts.length) setTimeout(() => openAccountDialog(), 500);
      if (state.accounts.length && !bootstrap.secretsRecoveryWarning && !state.messages.some((item) => item.folder === 'inbox')) setTimeout(() => syncNow(), 300);
    } catch (error) {
      $('#mailList').innerHTML = `<div class="bootstrap-error">LumenMail konnte nicht gestartet werden.<br><small>${escapeHtml(errorMessage(error))}</small></div>`;
      toast(errorMessage(error), 'error');
    }
  }

  init();
})();

