const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        protocolTimeout: 30000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

let whatsappListo = false;

client.on('qr', (qr) => {
    console.log('⚡ Escaneá el siguiente código QR con tu celular:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp listo. Verificando tareas programadas...');
    whatsappListo=true;
    
});

client.on('auth_failure', (msg) => {
    console.error('❌ Error de autenticación en WhatsApp:', msg);
});

// Función de envío con reintento/espera corta si aún está conectando
async function enviarMensaje(telefono, mensaje) {
    if (!whatsappListo) {
        console.log('⏳ Esperando a que WhatsApp complete la conexión...');
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    let num = telefono.toString().replace(/\D/g, '');
    if (num.startsWith('549')) {
        // ok
    } else if (num.startsWith('54')) {
        num = '549' + num.slice(2);
    } else if (num.startsWith('0')) {
        num = '549' + num.slice(1);
    } else {
        num = '549' + num;
    }

    const chatId = `${num}@c.us`;
    await client.sendMessage(chatId, mensaje);
}

module.exports = {
    client,
    enviarMensaje
};