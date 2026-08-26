const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const db = require('../config/db');
const { parsearErreparPDF } = require('../services/pdfParserService');
const { sincronizarVencimientosGlobal } = require('../services/vencimientosService');

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            err ? reject(err) : resolve(this);
        });
    });
}
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}

const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'application/pdf') {
            return cb(new Error('El archivo debe ser un PDF.'));
        }
        cb(null, true);
    }
});

// POST /api/agenda/importar-pdf - sube el calendario Errepar + año, devuelve preview.
// NO escribe en agenda_impositiva todavía: eso lo hace /confirmar.
router.post('/importar-pdf', (req, res, next) => {
    upload.single('pdf')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Error al subir el archivo.' });
        next();
    });
}, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No se recibió ningún archivo PDF.' });
    }
    const anio = parseInt(req.body.anio, 10);
    if (!anio || anio < 2020 || anio > 2100) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Indicá un año válido (ej: 2026).' });
    }

    try {
        const resultado = await parsearErreparPDF(req.file.path, anio);
        res.json(resultado); // { anio, cantidad_filas, filas: [...] }
    } catch (err) {
        console.error('❌ Error parseando PDF de Errepar:', err.message);
        res.status(400).json({ error: err.message });
    } finally {
        fs.unlink(req.file.path, () => {});
    }
});

// POST /api/agenda/confirmar - el usuario ya revisó el preview; recién acá se graba
// en agenda_impositiva. Los impuestos no reconocidos (nombre no existe en la base,
// o son de tipo_agenda='manual') se saltean y se informan, no rompen el resto.
router.post('/confirmar', async (req, res) => {
    const { filas } = req.body;

    if (!Array.isArray(filas) || filas.length === 0) {
        return res.status(400).json({ error: 'No hay filas para confirmar.' });
    }

    try {
        const cacheImpuestos = new Map(); // nombre -> {id, tipo_agenda} | null
        let cargadas = 0;
        const omitidas = new Map(); // nombre -> motivo

        for (const f of filas) {
            const { impuesto, periodo, terminacion_cuit, fecha_vencimiento } = f;

            if (!impuesto || !periodo || terminacion_cuit === undefined || !fecha_vencimiento) continue;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento)) continue;

            if (!cacheImpuestos.has(impuesto)) {
                const row = await dbGet(`SELECT id, tipo_agenda FROM impuestos WHERE nombre = ?`, [impuesto]);
                cacheImpuestos.set(impuesto, row || null);
            }
            const impRow = cacheImpuestos.get(impuesto);

            if (!impRow) {
                omitidas.set(impuesto, 'no existe un impuesto con ese nombre en la base');
                continue;
            }
            if (impRow.tipo_agenda === 'manual') {
                omitidas.set(impuesto, 'es un impuesto de carga manual, no admite agenda automática');
                continue;
            }

            await dbRun(
                `INSERT INTO agenda_impositiva (impuesto_id, terminacion_cuit, periodo, fecha_vencimiento)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(impuesto_id, terminacion_cuit, periodo) DO UPDATE SET
                    fecha_vencimiento = excluded.fecha_vencimiento`,
                [impRow.id, terminacion_cuit, periodo, fecha_vencimiento]
            );
            cargadas++;
        }

        // Propagamos la agenda nueva a los clientes que ya tienen impuestos asignados,
        // en vez de esperar al próximo reinicio del server o corrida del scraper.
        try {
            await sincronizarVencimientosGlobal();
        } catch (syncErr) {
            console.error('⚠️ Error sincronizando vencimientos tras importar agenda:', syncErr.message);
        }

        res.json({
            status: 'ok',
            mensaje: `${cargadas} fecha(s) cargada(s) en la agenda impositiva.`,
            omitidas: Array.from(omitidas, ([impuesto, motivo]) => ({ impuesto, motivo }))
        });
    } catch (err) {
        console.error('❌ Error confirmando agenda:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;