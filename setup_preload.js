const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('configAPI', {
    obtenerIpsLocales: () => ipcRenderer.invoke('config:obtener-ips-locales'),
    guardar: (config) => ipcRenderer.invoke('config:guardar', config)
});