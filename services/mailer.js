const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

/**
 * Envía un correo electrónico HTML
 */
async function enviarCorreo(destino, asunto, mensajeHtml) {
    if (!destino) return;

    try {
        const mailOptions = {
            from: `"Gestión Vencimientos" <${process.env.EMAIL_USER}>`,
            to: destino,
            subject: asunto,
            html: mensajeHtml
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`📧 Correo enviado a ${destino}: ${info.messageId}`);
        return info;
    } catch (error) {
        console.error(`❌ Error enviando correo a ${destino}:`, error.message);
        throw error;
    }
}

module.exports = {
    enviarCorreo
};