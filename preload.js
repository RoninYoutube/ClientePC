'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ringtoss', {
  getState: () => ipcRenderer.invoke('getState'),
  addAccount: () => ipcRenderer.invoke('addAccount'),
  removeAccount: (params) => ipcRenderer.invoke('removeAccount', typeof params === 'string' ? { accountId: params } : params),
  reorderAccounts: (params) => ipcRenderer.invoke('reorderAccounts', params || {}),
  saveAccount: (params) => ipcRenderer.invoke('saveAccount', typeof params === 'string' ? { accountId: params } : params),
  setActiveLogAccount: (params) => ipcRenderer.invoke('setActiveLogAccount', typeof params === 'string' ? { accountId: params } : params),
  connect: (params) => ipcRenderer.invoke('connect', typeof params === 'string' ? { accountId: params } : params),
  createAccount: (params) => ipcRenderer.invoke('createAccount', typeof params === 'string' ? { accountId: params } : params),
  disconnect: (params) => ipcRenderer.invoke('disconnect', typeof params === 'string' ? { accountId: params } : params),
  fly: (params) => ipcRenderer.invoke('fly', typeof params === 'string' ? { accountId: params } : params),
  movePerson: (params) => ipcRenderer.invoke('movePerson', typeof params === 'object' ? params : null),
  setGlobalPerson: (params) => ipcRenderer.invoke('setGlobalPerson', params || {}),
  sendGift: (params) => ipcRenderer.invoke('sendGift', typeof params === 'string' ? { accountId: params } : params),
  spinWheel: (params) => ipcRenderer.invoke('spinWheel', typeof params === 'string' ? { accountId: params } : params),
  setLogMode: (mode) => ipcRenderer.invoke('setLogMode', mode),
  setVisualEffects: (effects) => ipcRenderer.invoke('setVisualEffects', effects || {}),
  setSharedAlliesGroupCode: (params) => ipcRenderer.invoke('setSharedAlliesGroupCode', params || {}),
  syncSharedAllies: () => ipcRenderer.invoke('syncSharedAllies'),
  setTelegramChatId: (params) => ipcRenderer.invoke('setTelegramChatId', params || {}),
  setTelegramExternalAccountId: (params) => ipcRenderer.invoke('setTelegramExternalAccountId', params || {}),
  syncTelegram: () => ipcRenderer.invoke('syncTelegram'),
  clearLogs: (params) => ipcRenderer.invoke('clearLogs', typeof params === 'string' ? { accountId: params } : params),
  sendChat: (params) => ipcRenderer.invoke('sendChat', typeof params === 'object' ? params : null),
  setSupplierConfig: (config) => ipcRenderer.invoke('setSupplierConfig', config || {}),
  checkSupplierNow: () => ipcRenderer.invoke('checkSupplierNow'),
  onState: (callback) => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  }
});
