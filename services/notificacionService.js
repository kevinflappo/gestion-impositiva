const { enviarMensaje } = require('./whatsapp');
const { enviarCorreo } = require('./mailer');

/**
 * Arma el texto del mensaje (WhatsApp) y el HTML (Email) para un vencimiento.
 * Se usa tanto para el aviso automático mensual como para el botón manual.
 */
function formatearMensaje({ cliente_nombre, impuesto_nombre, categoria, fecha_vencimiento, monto }) {
    const textoCategoria = categoria ? ` (Cat. ${categoria})` : '';
    const montoFormateado = Number(monto || 0).toLocaleString('es-AR');

    const textoWhatsapp =
        `Hola *${cliente_nombre}*, te recordamos el vencimiento de *${impuesto_nombre}${textoCategoria}*.\n\n` +
        `📅 Vencimiento: *${fecha_vencimiento}*\n` +
        `💰 Monto a abonar: *$${montoFormateado}*`;

    const htmlEmail = `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 8px;">
            <h2 style="color: #0d6efd;">📋 Recordatorio de Vencimiento</h2>
            <p>Hola <strong>${cliente_nombre}</strong>, te recordamos que tenés un vencimiento próximo:</p>
            <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 6px 0;"><strong>Impuesto:</strong></td><td style="padding: 6px 0;">${impuesto_nombre}${textoCategoria}</td></tr>
                <tr><td style="padding: 6px 0;"><strong>Vencimiento:</strong></td><td style="padding: 6px 0;">${fecha_vencimiento}</td></tr>
                <tr><td style="padding: 6px 0;"><strong>Monto:</strong></td><td style="padding: 6px 0;">$${montoFormateado}</td></tr>
            </table>
        </div>
    `;

    return {
        asunto: `🚨 Recordatorio: Vencimiento de ${impuesto_nombre} (${fecha_vencimiento})`,
        textoWhatsapp,
        htmlEmail
    };
}

/**
 * Notifica un vencimiento por el canal indicado, o si no se especifica ('auto'),
 * elige con la prioridad: WhatsApp > Email > (nadie, si no hay datos de contacto).
 *
 * @param {object} datos - { cliente_nombre, telefono, email, impuesto_nombre, categoria, fecha_vencimiento, monto }
 * @param {'whatsapp'|'email'|'auto'} canal - canal forzado, o 'auto' (default) para elegir según prioridad
 * @returns {Promise<{enviado: boolean, canal: string|null, motivo?: string}>}
 */
async function notificarVencimiento(datos, canal = 'auto') {
    const { telefono, email } = datos;
    const mensaje = formatearMensaje(datos);

    const canalAUsar = canal === 'auto'
        ? (telefono ? 'whatsapp' : (email ? 'email' : null))
        : canal;

    if (canalAUsar === 'whatsapp') {
        if (!telefono) return { enviado: false, canal: 'whatsapp', motivo: 'El cliente no tiene teléfono cargado.' };
        await enviarMensaje(telefono, mensaje.textoWhatsapp);
        return { enviado: true, canal: 'whatsapp' };
    }

    if (canalAUsar === 'email') {
        if (!email) return { enviado: false, canal: 'email', motivo: 'El cliente no tiene email cargado.' };
        await enviarCorreo(email, mensaje.asunto, mensaje.htmlEmail);
        return { enviado: true, canal: 'email' };
    }

    return { enviado: false, canal: null, motivo: 'El cliente no tiene teléfono ni email cargados.' };
}

module.exports = {
    notificarVencimiento,
    formatearMensaje
};