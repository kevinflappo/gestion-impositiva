const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const db = require('../config/db');
const { parsearFeriadosPDF } = require('../services/pdfParserService');

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            err ? reject(err) : resolve(this);
        });
    });
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

// El PDF se guarda temporalmente en el tmp del sistema y se borra apenas se parsea.
const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB de sobra para un PDF de un par de páginas
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'application/pdf') {
            return cb(new Error('El archivo debe ser un PDF.'));
        }
        cb(null, true);
    }
});

// GET /api/feriados?anio=2026 - listar feriados cargados (para visibilidad/admin)
router.get('/', async (req, res) => {
    const { anio } = req.query;
    try {
        const sql = anio
            ? `SELECT fecha, motivo, tipo FROM feriados WHERE fecha LIKE ? ORDER BY fecha`
            : `SELECT fecha, motivo, tipo FROM feriados ORDER BY fecha`;
        const params = anio ? [`${anio}-%`] : [];
        const rows = await dbAll(sql, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/feriados/importar-pdf - sube el PDF, lo parsea, devuelve preview.
// NO escribe en la base todavía: eso lo hace /confirmar, después de la revisión.
router.post('/importar-pdf', (req, res, next) => {
    // Envolvemos multer a mano: si rechaza el archivo (no es PDF, pesa de más),
    // el error hay que capturarlo acá o Express lo deja pasar a su handler por
    // defecto, que devuelve HTML en vez de JSON.
    upload.single('pdf')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message || 'Error al subir el archivo.' });
        }
        next();
    });
}, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No se recibió ningún archivo PDF.' });
    }

    try {
        const resultado = await parsearFeriadosPDF(req.file.path);
        res.json(resultado); // { anio, feriados: [...] }
    } catch (err) {
        console.error('❌ Error parseando PDF de feriados:', err.message);
        res.status(400).json({ error: err.message });
    } finally {
        // Borramos siempre el archivo temporal, haya salido bien o mal
        fs.unlink(req.file.path, () => {});
    }
});

// POST /api/feriados/confirmar - el usuario ya revisó el preview; recién acá se graba.
router.post('/confirmar', async (req, res) => {
    const { feriados } = req.body;

    if (!Array.isArray(feriados) || feriados.length === 0) {
        return res.status(400).json({ error: 'No hay feriados para confirmar.' });
    }

    try {
        let cargados = 0;
        for (const f of feriados) {
            if (!f.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(f.fecha)) continue; // salteamos filas mal formadas
            await dbRun(
                `INSERT INTO feriados (fecha, motivo, tipo) VALUES (?, ?, ?)
                 ON CONFLICT(fecha) DO UPDATE SET motivo = excluded.motivo, tipo = excluded.tipo`,
                [f.fecha, f.motivo || '', f.tipo || '']
            );
            cargados++;
        }
        res.json({ status: 'ok', mensaje: `${cargados} feriado(s) cargado(s) correctamente.` });
    } catch (err) {
        console.error('❌ Error confirmando feriados:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;