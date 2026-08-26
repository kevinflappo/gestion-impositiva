const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const configPath = path.join(app.getPath('userData'), 'config.json');

function refrescarFocoVentana(win) {
    if (!win) return;
    win.setEnabled(false);
    win.setEnabled(true);
    win.focus();
}

ipcMain.on('refrescar-foco', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    setTimeout(() => refrescarFocoVentana(win), 50);
});

function leerConfig() {
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        return null; // no existe todavía (primera vez que se abre la app)
    }
}

function guardarConfig(config) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function obtenerIpsLocales() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const nombre in interfaces) {
        for (const iface of interfaces[nombre]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}

let mainWindow;
let setupWindow;

function abrirVentanaPrincipal(url) {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        icon: path.join(__dirname, 'public/favicon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    mainWindow.loadURL(url);
    mainWindow.maximize();
    mainWindow.on('closed', () => { mainWindow = null; });
}

function iniciarComoServidor() {
    // Definimos la ruta segura de SQLite en AppData del usuario
    process.env.DB_PATH = path.join(app.getPath('userData'), 'vencimientos.db');

    // Arranca Express + SQLite + crons
    require('./server.js');

    abrirVentanaPrincipal('http://localhost:3000');
}

function iniciarComoCliente(ipServidor) {
    abrirVentanaPrincipal(`http://${ipServidor}:3000`);
}

function abrirVentanaConfiguracion() {
    setupWindow = new BrowserWindow({
        width: 480,
        height: 460,
        resizable: false,
        icon: path.join(__dirname, 'public/favicon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'setup_preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    setupWindow.setMenuBarVisibility(false);
    setupWindow.loadFile(path.join(__dirname, 'setup.html'));
}

// --- Comunicación con la ventana de configuración ---
ipcMain.handle('config:obtener-ips-locales', () => obtenerIpsLocales());

ipcMain.handle('config:guardar', (event, config) => {
    try {
        guardarConfig(config);
        if (setupWindow) {
            setupWindow.close();
            setupWindow = null;
        }

        if (config.modo === 'servidor') {
            iniciarComoServidor();
        } else {
            iniciarComoCliente(config.ipServidor);
        }
    } catch (err) {
        console.error('❌ Error al guardar configuración e iniciar:', err);
        dialog.showErrorBox('Error al iniciar', `Ocurrió un error al guardar la configuración:\n\n${err.message}`);
    }
});

// --- Arranque de la app ---
app.whenReady().then(() => {
    const config = leerConfig();

    if (!config) {
        abrirVentanaConfiguracion();
        return;
    }

    if (config.modo === 'servidor') {
        iniciarComoServidor();
    } else {
        iniciarComoCliente(config.ipServidor);
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        const config = leerConfig();
        if (!config) {
            abrirVentanaConfiguracion();
        } else if (config.modo === 'servidor') {
            iniciarComoServidor();
        } else {
            iniciarComoCliente(config.ipServidor);
        }
    }
});