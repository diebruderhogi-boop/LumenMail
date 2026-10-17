const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('lumen', {
  bootstrap: invoke('app:bootstrap'),
  listMessages: invoke('mail:list'),
  getMessage: invoke('mail:get'),
  sync: invoke('mail:sync'),
  action: invoke('mail:action'),
  saveDraft: invoke('draft:save'),
  getDraft: invoke('draft:get'),
  deleteDraft: invoke('draft:delete'),
  send: invoke('mail:send'),
  pickAttachments: invoke('files:pick'),
  saveAttachment: invoke('files:save-attachment'),
  testAccount: invoke('account:test'),
  saveAccount: invoke('account:save'),
  deleteAccount: invoke('account:delete'),
  saveSettings: invoke('settings:save'),
  connectChatGPT: invoke('chatgpt:connect'),
  disconnectChatGPT: invoke('chatgpt:disconnect'),
  openChatGPTUsage: invoke('chatgpt:usage'),
  ai: invoke('ai:action'),
  chat: invoke('ai:chat'),
  onSync: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('mail:sync-progress', listener);
    return () => ipcRenderer.removeListener('mail:sync-progress', listener);
  },
  onNewMail: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('mail:new', listener);
    return () => ipcRenderer.removeListener('mail:new', listener);
  },
  onSortStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('mail:sort-status', listener);
    return () => ipcRenderer.removeListener('mail:sort-status', listener);
  }
});

