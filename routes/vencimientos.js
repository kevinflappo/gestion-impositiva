const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { notificarVencimiento } = require('../services/notificacionService');

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

router.get('/', (req, res) => {
    const periodoFiltro = req.query.periodo;
    const fechaFiltro = req.query.fecha; // 👈 Captura el día exacto si se envía

    // Si el usuario pasa un período específico (YYYY-MM), lo usamos. Si no, usamos el mes actual.
    const hoy = new Date();
    const anioActual = hoy.getFullYear();
    const mesActual = String(hoy.getMonth() + 1).padStart(2, '0');
    const periodoPorDefecto = `${anioActual}-${mesActual}`;

    const periodoAResolver = periodoFiltro || periodoPorDefecto;

    // 👇 Join directo por cliente_id: cada fila de "vencimientos" YA es la instancia
    // real de un cliente (ver services/vencimientosService.js), así que no hace
    // falta reconstruir nada por terminación de CUIT ni deduplicar con GROUP BY.
    let sql = `
        SELECT 
            v.id,
            c.razon_social AS cliente_nombre,
            c.cuit,
            i.nombre AS impuesto_nombre,
            ci.categoria,
            v.fecha_vencimiento,
            v.periodo,
            v.estado,
            v.monto,
            'ARCA' AS organismo
        FROM vencimientos v
        JOIN clientes c ON v.cliente_id = c.id
        JOIN impuestos i ON v.impuesto_id = i.id
        LEFT JOIN cliente_impuestos ci ON (ci.cliente_id = c.id AND ci.impuesto_id = i.id)
    `;

    const params = [];

    // 👇 Condicional dinámico: si hay fecha exacta, filtra por eso; si no, filtra por el período mensual.
    if (fechaFiltro) {
        sql += ` WHERE v.fecha_vencimiento = ?`;
        params.push(fechaFiltro);
    } else {
        sql += ` WHERE v.periodo = ?`;
        params.push(periodoAResolver);
    }

    sql += ` ORDER BY v.fecha_vencimiento ASC`;

    db.all(sql, params, (err, rows) => {
        if (err) {
            console.error('❌ Error en GET /vencimientos:', err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

router.put('/:id/estado', (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;

    db.run(`UPDATE vencimientos SET estado = ? WHERE id = ?`, [estado, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: 'ok', cambios: this.changes });
    });
});

// Carga manual de fecha + monto para impuestos que NO tienen agenda automática
// (ej: Honorarios Contables, Casas Particulares por ahora). Solo funciona con
// impuestos marcados tipo_agenda = 'manual' — para el resto, usar /impuestos/asignar.
router.post('/manual', async (req, res) => {
    const { cliente_id, impuesto_id, fecha_vencimiento, monto } = req.body;

    if (!cliente_id || !impuesto_id || !fecha_vencimiento) {
        return res.status(400).json({ error: 'cliente_id, impuesto_id y fecha_vencimiento son obligatorios.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha_vencimiento)) {
        return res.status(400).json({ error: 'fecha_vencimiento debe tener formato YYYY-MM-DD.' });
    }

    try {
        const impuesto = await dbGet(`SELECT id, nombre, tipo_agenda FROM impuestos WHERE id = ?`, [impuesto_id]);
        if (!impuesto) return res.status(404).json({ error: 'Impuesto no encontrado' });
        if (impuesto.tipo_agenda !== 'manual') {
            return res.status(400).json({
                error: `"${impuesto.nombre}" no es un impuesto de carga manual. Asignalo desde "Asignar/Gestionar Impuestos".`
            });
        }

        const cliente = await dbGet(`SELECT id, cuit FROM clientes WHERE id = ?`, [cliente_id]);
        if (!cliente) return res.status(404).json({ error: 'Cliente no encontrado' });

        const terminacion = parseInt(cliente.cuit.toString().replace(/\D/g, '').slice(-1), 10);
        const periodo = fecha_vencimiento.slice(0, 7); // YYYY-MM derivado de la fecha cargada
        const montoFinal = Number(monto) || 0;

        // Aseguramos el vínculo cliente-impuesto (sin categoría, no aplica en manuales)
        await dbRun(
            `INSERT OR IGNORE INTO cliente_impuestos (cliente_id, impuesto_id, categoria) VALUES (?, ?, NULL)`,
            [cliente_id, impuesto_id]
        );

        // Mismo criterio que el sync automático: nunca pisa un vencimiento ya PAGADO
        await dbRun(
            `INSERT INTO vencimientos (cliente_id, impuesto_id, terminacion_cuit, periodo, fecha_vencimiento, monto, estado)
             VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE')
             ON CONFLICT(cliente_id, impuesto_id, periodo) DO UPDATE SET
                fecha_vencimiento = excluded.fecha_vencimiento,
                monto = excluded.monto
             WHERE vencimientos.estado != 'PAGADO'`,
            [cliente_id, impuesto_id, terminacion, periodo, fecha_vencimiento, montoFinal]
        );

        res.json({ status: 'ok', mensaje: 'Vencimiento manual cargado correctamente' });
    } catch (err) {
        console.error('❌ Error cargando vencimiento manual:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Aviso manual de un vencimiento puntual, eligiendo el canal (para cuando la
// contadora ya sabe que el cliente prefiere WhatsApp o email en particular).
// También permite cargar/corregir el monto justo antes de avisar (ej: IVA,
// que el contador recién termina de calcular).
router.post('/:id/notificar', async (req, res) => {
    const { id } = req.params;
    const { canal, monto } = req.body;

    const canalValido = ['auto', 'whatsapp', 'email'].includes(canal) ? canal : 'auto';

    try {
        if (monto !== undefined && monto !== null && monto !== '') {
            const montoNum = Number(monto);
            if (isNaN(montoNum) || montoNum < 0) {
                return res.status(400).json({ error: 'El monto debe ser un número válido.' });
            }
            await dbRun(`UPDATE vencimientos SET monto = ? WHERE id = ?`, [montoNum, id]);
        }

        const vencimiento = await dbGet(
            `SELECT v.id, v.fecha_vencimiento, v.monto, v.periodo,
                    c.razon_social AS cliente_nombre, c.telefono, c.email_notificacion AS email,
                    i.nombre AS impuesto_nombre, ci.categoria
             FROM vencimientos v
             JOIN clientes c ON v.cliente_id = c.id
             JOIN impuestos i ON v.impuesto_id = i.id
             LEFT JOIN cliente_impuestos ci ON (ci.cliente_id = c.id AND ci.impuesto_id = i.id)
             WHERE v.id = ?`,
            [id]
        );

        if (!vencimiento) return res.status(404).json({ error: 'Vencimiento no encontrado' });

        const resultado = await notificarVencimiento(vencimiento, canalValido);

        if (!resultado.enviado) {
            return res.status(400).json({ error: resultado.motivo, canal: resultado.canal });
        }

        res.json({ status: 'ok', mensaje: `Aviso enviado por ${resultado.canal}`, canal: resultado.canal });
    } catch (err) {
        console.error('❌ Error notificando vencimiento:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;