const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Fuerza un ciclo enable/disable de la BrowserWindow para resincronizar
    // el foco nativo de Windows. Ver main.js -> refrescarFocoVentana().
    refrescarFoco: () => ipcRenderer.send('refrescar-foco')
});