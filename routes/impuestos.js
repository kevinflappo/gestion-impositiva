const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sincronizarVencimientosCliente } = require('../services/vencimientosService');

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

// Obtener lista única de impuestos (incluye tipo_agenda para que el frontend sepa
// cuáles van por el flujo de categorías/ARCA y cuáles son de carga manual)
router.get('/', (req, res) => {
    db.all(`SELECT id, nombre, tipo_agenda FROM impuestos GROUP BY LOWER(TRIM(nombre)) ORDER BY nombre ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Crear un nuevo impuesto de carga MANUAL (ej: "Tasa Municipal", "Sellos", etc).
// Los impuestos automáticos (con regla en scraper.py) no se crean desde acá.
router.post('/', async (req, res) => {
    const { nombre } = req.body;

    if (!nombre || !nombre.trim()) {
        return res.status(400).json({ error: 'El nombre del impuesto es obligatorio.' });
    }

    try {
        const result = await dbRun(
            `INSERT INTO impuestos (nombre, tipo_agenda) VALUES (?, 'manual')`,
            [nombre.trim()]
        );
        res.json({ id: result.lastID, mensaje: 'Impuesto manual creado correctamente' });
    } catch (err) {
        if (/UNIQUE/i.test(err.message)) {
            return res.status(400).json({ error: 'Ya existe un impuesto con ese nombre.' });
        }
        console.error('❌ Error creando impuesto manual:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Obtener impuestos asignados a un cliente
router.get('/cliente/:clienteId', (req, res) => {
    const { clienteId } = req.params;
    const sql = `
        SELECT ci.impuesto_id, ci.categoria, i.nombre 
        FROM cliente_impuestos ci
        JOIN impuestos i ON ci.impuesto_id = i.id
        WHERE ci.cliente_id = ?
    `;
    db.all(sql, [clienteId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Asignar impuestos + Categoría a un cliente.
// El cálculo de fecha y monto de cada vencimiento lo hace vencimientosService,
// leyendo agenda_impositiva (cargada por el scraper) y montos_categorias.
router.post('/asignar', async (req, res) => {
    const { cliente_id, impuestos } = req.body;

    if (!cliente_id || !impuestos || !Array.isArray(impuestos)) {
        return res.status(400).json({ error: 'Datos no válidos' });
    }

    try {
        const cliente = await dbGet(`SELECT id FROM clientes WHERE id = ?`, [cliente_id]);
        if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

        // Este flujo es solo para impuestos AUTOMÁTICOS (con agenda calculada por el
        // scraper). Los manuales (ej: Honorarios) se cargan desde /vencimientos/manual.
        for (const item of impuestos) {
            const impId = parseInt(item.impuesto_id, 10);
            const impuesto = await dbGet(`SELECT nombre, tipo_agenda FROM impuestos WHERE id = ?`, [impId]);
            if (!impuesto) {
                return res.status(400).json({ error: `No existe el impuesto con id ${impId}.` });
            }
            if (impuesto.tipo_agenda === 'manual') {
                return res.status(400).json({
                    error: `"${impuesto.nombre}" es un impuesto de carga manual y no tiene fechas automáticas. Cargalo desde el apartado de vencimientos manuales.`
                });
            }
        }

        // Reemplazamos la asignación completa: se borra lo anterior y se carga lo nuevo.
        // Es más simple y predecible que intentar hacer un diff impuesto por impuesto.
        await dbRun(`DELETE FROM cliente_impuestos WHERE cliente_id = ?`, [cliente_id]);
        await dbRun(`DELETE FROM vencimientos WHERE cliente_id = ?`, [cliente_id]);

        for (const item of impuestos) {
            const impId = parseInt(item.impuesto_id, 10);
            const categoria = item.categoria || null;
            await dbRun(
                `INSERT INTO cliente_impuestos (cliente_id, impuesto_id, categoria) VALUES (?, ?, ?)`,
                [cliente_id, impId, categoria]
            );
        }

        // Genera los vencimientos reales del cliente a partir de agenda_impositiva
        await sincronizarVencimientosCliente(cliente_id);

        res.json({ status: 'ok', mensaje: 'Impuestos y categorías asignados correctamente' });
    } catch (err) {
        console.error('❌ Error asignando impuestos:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;