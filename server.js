require('dotenv').config();
const express = require('express');
const path = require('path');

// 1. Importar servicios y tareas
const { client } = require('./services/whatsapp');
const { sincronizarVencimientosGlobal } = require('./services/vencimientosService');
const { ejecutarScraperARCA } = require('./services/scraperService');

// 2. Importar rutas de la API
const clientesRoutes = require('./routes/clientes');
const impuestosRoutes = require('./routes/impuestos');
const vencimientosRoutes = require('./routes/vencimientos');
const feriadosRoutes = require('./routes/feriados');
const agendaRoutes = require('./routes/agenda');

const app = express();
const PORT = process.env.PORT || 3000;

const cron = require('node-cron');
///const { verificarYEjecutarAvisosMensuales } = require('./jobs/avisosMensuales');
const { enviarResumenDiarioContador } = require('./jobs/avisoContador');
// Protecciones globales para evitar que un fallo inesperado tire el servidor
process.on('uncaughtException', (err) => {
    console.error('⚠️ Excepción no capturada (controlada):', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Promesa rechazada no manejada:', reason);
});

// Middlewares para procesar JSON y archivos estáticos
// Límite subido a 5mb: la confirmación de la agenda Errepar manda ~1000 filas (~120KB),
// por encima del límite por defecto de Express (100kb).
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // Servir el HTML/frontend

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 3. Montar las rutas en la app Express
app.use('/api/clientes', clientesRoutes);
app.use('/api/impuestos', impuestosRoutes);
app.use('/api/vencimientos', vencimientosRoutes);
app.use('/api/feriados', feriadosRoutes);
app.use('/api/agenda', agendaRoutes);

// Manejo retrocompatible para mantener vivas las rutas viejas que usaba el HTML
app.use('/api/asignar-impuesto', (req, res, next) => {
    req.url = '/asignar';
    impuestosRoutes(req, res, next);
});

app.use('/api/resumen-diario', (req, res, next) => {
    req.url = '/resumen-diario';
    vencimientosRoutes(req, res, next);
});

// 📌 Actualiza la agenda impositiva (scraper.py) y la propaga a los clientes
// ya asignados. Reemplaza lo que antes disparaba avisosMensuales.js, pero
// SIN nada de notificaciones — solo mantiene las fechas al día.
async function actualizarAgendaImpositiva() {
    console.log('🔄 [AGENDA] Actualizando agenda impositiva...');
    try {
        await ejecutarScraperARCA();
    } catch (e) {
        console.error('⚠️ [AGENDA] No se pudo correr el scraper, se sigue con los datos previos:', e.message);
    }
    try {
        await sincronizarVencimientosGlobal();
    } catch (e) {
        console.error('⚠️ [AGENDA] Error sincronizando vencimientos:', e.message);
    }
    console.log('✅ [AGENDA] Actualización completada.');
}

// 4. Disparador de WhatsApp y tarea de avisos al iniciar
client.on('ready', () => {
    console.log('✅ WhatsApp listo. Programando tareas automáticas (Cron)...');

    // 🚀 A) Chequeo al encender/iniciar el servidor (por si se prendió después de las 8:00 AM)
    setTimeout(() => {
        ///verificarYEjecutarAvisosMensuales();
        enviarResumenDiarioContador();
    }, 10000);

    // ⏰ B) CRON: Todos los días a las 08:00 AM
    cron.schedule('0 8 * * *', () => {
        console.log('⏰ [CRON 08:00 AM] Ejecutando tareas programadas del día...');
        ///verificarYEjecutarAvisosMensuales();
        enviarResumenDiarioContador();
    });
});

// Inicializar el cliente de WhatsApp Web
client.initialize();

// ⏰ CRON de la agenda impositiva: todos los días a las 07:00 AM, independiente
// de WhatsApp (no tiene sentido que la actualización de fechas dependa de que
// WhatsApp termine de autenticar, ya que no manda ningún mensaje).
cron.schedule('0 7 * * *', () => {
    console.log('⏰ [CRON 07:00 AM] Actualizando agenda impositiva...');
    actualizarAgendaImpositiva();
});

// Manejador de errores global: cualquier error no capturado en una ruta (JSON
// mal formado, payload demasiado grande, etc) devuelve JSON, nunca la página
// HTML de error por defecto de Express (que rompe cualquier fetch() del frontend).
app.use((err, req, res, next) => {
    console.error('❌ Error no manejado:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor.' });
});

// 5. Iniciar Servidor Express
// Escucha en 0.0.0.0 (todas las interfaces de red), no solo en localhost —
// así las otras 2 PCs de la red pueden conectarse a esta como "cliente".
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor corriendo exitosamente en http://localhost:${PORT}`);

    // Red de seguridad: sincroniza los vencimientos de los clientes ya cargados
    // contra la agenda_impositiva actual. Corre sola al bootear el server, sin
    // depender de que WhatsApp termine de autenticar. Cubre tanto la migración
    // al nuevo modelo de vencimientos como los reinicios normales del server.
    setTimeout(() => {
        actualizarAgendaImpositiva();
    }, 2000);
});