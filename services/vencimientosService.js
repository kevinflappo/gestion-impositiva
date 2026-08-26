const db = require('../config/db');

// ---- Helpers para poder usar async/await con sqlite3 (que es 100% callbacks) ----
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            err ? reject(err) : resolve(this);
        });
    });
}

/**
 * Busca el monto vigente para un impuesto+categoría en montos_categorias.
 * Si el impuesto no tiene categoría (ej. IVA, Ingresos Brutos) devuelve 0.
 * (De paso corrige un bug del código viejo: comparaba impuesto_nombre LIKE
 * contra la categoría, lo cual no tenía sentido y podía traer montos de otro impuesto).
 */
async function buscarMonto(impuestoNombre, categoria) {
    if (!categoria) return 0;
    const row = await dbGet(
        `SELECT monto FROM montos_categorias WHERE impuesto_nombre LIKE ? AND categoria = ? LIMIT 1`,
        [`%${impuestoNombre}%`, categoria]
    );
    return row?.monto || 0;
}

/**
 * Sincroniza los vencimientos REALES de UN cliente contra agenda_impositiva.
 * - Crea las filas que falten (ej: nuevos períodos que acaba de agregar el scraper).
 * - Actualiza la fecha de las que ya existen, PERO solo si siguen PENDIENTE
 *   (nunca pisa un vencimiento que el contador ya marcó PAGADO).
 * - No borra nada: si un impuesto se desasigna, el borrado lo maneja quien
 *   llama a esta función (ej. impuestos.js borra antes de reasignar).
 */
async function sincronizarVencimientosCliente(clienteId) {
    const cliente = await dbGet(`SELECT cuit FROM clientes WHERE id = ?`, [clienteId]);
    if (!cliente) return;

    const terminacion = parseInt(cliente.cuit.toString().replace(/\D/g, '').slice(-1), 10);

    const asignaciones = await dbAll(
        `SELECT ci.impuesto_id, ci.categoria, i.nombre AS impuesto_nombre
         FROM cliente_impuestos ci
         JOIN impuestos i ON i.id = ci.impuesto_id
         WHERE ci.cliente_id = ?`,
        [clienteId]
    );

    for (const asign of asignaciones) {
        const fechas = await dbAll(
            `SELECT periodo, fecha_vencimiento FROM agenda_impositiva
             WHERE impuesto_id = ? AND terminacion_cuit = ?`,
            [asign.impuesto_id, terminacion]
        );

        if (fechas.length === 0) continue; // el scraper todavía no generó fechas para este impuesto/terminación

        const monto = await buscarMonto(asign.impuesto_nombre, asign.categoria);

        for (const f of fechas) {
            await dbRun(
                `INSERT INTO vencimientos (cliente_id, impuesto_id, terminacion_cuit, periodo, fecha_vencimiento, monto, estado)
                 VALUES (?, ?, ?, ?, ?, ?, 'PENDIENTE')
                 ON CONFLICT(cliente_id, impuesto_id, periodo) DO UPDATE SET
                    fecha_vencimiento = excluded.fecha_vencimiento,
                    monto = excluded.monto
                 WHERE vencimientos.estado != 'PAGADO'`,
                [clienteId, asign.impuesto_id, terminacion, f.periodo, f.fecha_vencimiento, monto]
            );
        }
    }
}

/**
 * Sincroniza TODOS los clientes que tienen al menos un impuesto asignado.
 * Se usa después de correr el scraper, para propagar los períodos nuevos
 * (ej: el scraper agrega el mes actual + 2 meses) a los clientes ya cargados.
 */
async function sincronizarVencimientosGlobal() {
    const clientes = await dbAll(`SELECT DISTINCT cliente_id FROM cliente_impuestos`);

    for (const c of clientes) {
        try {
            await sincronizarVencimientosCliente(c.cliente_id);
        } catch (err) {
            console.error(`❌ [SYNC] Error sincronizando vencimientos del cliente ${c.cliente_id}:`, err.message);
        }
    }

    console.log(`✅ [SYNC] Vencimientos sincronizados para ${clientes.length} cliente(s).`);
}

module.exports = {
    sincronizarVencimientosCliente,
    sincronizarVencimientosGlobal
};