const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('whaleMeter', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  widgetBootstrap: () => ipcRenderer.invoke('widget:bootstrap'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  refreshBalance: () => ipcRenderer.invoke('balance:refresh'),
  clearEvents: () => ipcRenderer.invoke('events:clear'),
  getProxyStatus: () => ipcRenderer.invoke('proxy:status'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  openDashboard: (section = '') => ipcRenderer.invoke('window:open-dashboard', section),
  hideWidget: () => ipcRenderer.invoke('widget:hide'),
  widgetRefreshBalance: () => ipcRenderer.invoke('widget:refresh-balance'),
  widgetOpenDashboard: (section = '') => ipcRenderer.invoke('widget:open-dashboard', section),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onUsage: (callback) => subscribe('usage:event', callback),
  onBalance: (callback) => subscribe('balance:update', callback),
  onProxyStatus: (callback) => subscribe('proxy:status', callback),
  onSettings: (callback) => subscribe('settings:updated', callback),
  onNavigate: (callback) => subscribe('dashboard:navigate', callback),
  onWidgetSnapshot: (callback) => subscribe('widget:snapshot', callback),
  onWidgetUpdate: (callback) => subscribe('widget:update', callback),
  onWidgetBalance: (callback) => subscribe('widget:balance', callback),
  onWidgetProxy: (callback) => subscribe('widget:proxy', callback),
  onWidgetSettings: (callback) => subscribe('widget:settings', callback),
  onWidgetReveal: (callback) => subscribe('widget:reveal', callback),
});
