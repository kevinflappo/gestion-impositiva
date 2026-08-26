const db = require('../config/db');
const { enviarCorreo } = require('../services/mailer');

async function enviarResumenDiarioContador() {
    const hoy = new Date();
    const fechaHoyStr = hoy.toISOString().split('T')[0];
    const claveControl = `contador_${fechaHoyStr}`;

    // Verificación en la BD para evitar duplicados si la PC se reinicia el mismo día
    db.get(`SELECT periodo FROM control_envios WHERE periodo = ?`, [claveControl], async (err, row) => {
        if (err) return console.error('❌ Error consultando control_envios:', err.message);

        if (row) {
            console.log(`ℹ️ [AVISO CONTADOR] El resumen diario de hoy (${fechaHoyStr}) ya fue enviado.`);
            return;
        }

        const manana = new Date(hoy);
        manana.setDate(hoy.getDate() + 1);
        const fechaMananaStr = manana.toISOString().split('T')[0];

        const emailContador = process.env.EMAIL_USER;
        if (!emailContador) {
            console.warn('⚠️ [AVISO CONTADOR] No hay EMAIL_USER configurado en .env.');
            return;
        }

        console.log(`⏰ [AVISO CONTADOR] Generando resumen diario de vencimientos (${fechaHoyStr} / ${fechaMananaStr})...`);

        const query = `
            SELECT 
                c.razon_social,
                c.cuit,
                i.nombre AS impuesto,
                ci.categoria,
                v.fecha_vencimiento,
                v.estado
            FROM vencimientos v
            JOIN clientes c ON v.cliente_id = c.id
            JOIN impuestos i ON v.impuesto_id = i.id
            LEFT JOIN cliente_impuestos ci ON (ci.cliente_id = c.id AND ci.impuesto_id = i.id)
            WHERE v.fecha_vencimiento IN (?, ?)
            ORDER BY v.fecha_vencimiento ASC, c.razon_social ASC
        `;

        db.all(query, [fechaHoyStr, fechaMananaStr], async (err, vencimientos) => {
            if (err) return console.error('❌ Error consultando vencimientos:', err.message);

            if (!vencimientos || vencimientos.length === 0) {
                console.log('ℹ️ [AVISO CONTADOR] No hay vencimientos para hoy ni para mañana.');
                db.run(`INSERT INTO control_envios (periodo) VALUES (?)`, [claveControl]);
                return;
            }

            let filasHtml = '';
            vencimientos.forEach(v => {
                const esHoy = v.fecha_vencimiento === fechaHoyStr;
                const badgeEtiqueta = esHoy 
                    ? '<span style="background-color:#dc3545; color:white; padding:3px 7px; border-radius:3px; font-weight:bold;">HOY</span>' 
                    : '<span style="background-color:#ffc107; color:black; padding:3px 7px; border-radius:3px; font-weight:bold;">MAÑANA</span>';
                
                const categoriaTxt = v.categoria ? ` (${v.categoria})` : '';

                filasHtml += `
                    <tr style="border-bottom: 1px solid #ddd;">
                        <td style="padding: 10px;">${badgeEtiqueta}</td>
                        <td style="padding: 10px;"><strong>${v.razon_social}</strong><br><small>CUIT: ${v.cuit}</small></td>
                        <td style="padding: 10px;">${v.impuesto}${categoriaTxt}</td>
                        <td style="padding: 10px;">${v.estado}</td>
                    </tr>
                `;
            });

            const htmlCorreo = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
                    <h2 style="color: #0d6efd;">📋 Resumen Diario de Vencimientos</h2>
                    <p>Hola Contador, estos son los impuestos que vencen <strong>hoy (${fechaHoyStr})</strong> y <strong>mañana (${fechaMananaStr})</strong>:</p>
                    <table style="width: 100%; border-collapse: collapse; text-align: left;">
                        <thead>
                            <tr style="background-color: #f8f9fa;">
                                <th style="padding: 10px;">Día</th>
                                <th style="padding: 10px;">Cliente</th>
                                <th style="padding: 10px;">Impuesto</th>
                                <th style="padding: 10px;">Estado</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${filasHtml}
                        </tbody>
                    </table>
                </div>
            `;

            try {
                await enviarCorreo(emailContador, `🚨 Resumen Diario: Vencimientos para Hoy y Mañana (${fechaHoyStr})`, htmlCorreo);
                console.log('✅ [AVISO CONTADOR] Resumen diario enviado a Gmail.');
                db.run(`INSERT INTO control_envios (periodo) VALUES (?)`, [claveControl]);
            } catch (mailErr) {
                console.error('❌ Error enviando mail al contador:', mailErr.message);
            }
        });
    });
}

module.exports = { enviarResumenDiarioContador };