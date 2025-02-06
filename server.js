const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qr-image');
const axios = require('axios');
const cors = require('cors');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "https://asistentewhats.netlify.app",
        methods: ["GET", "POST"],
        credentials: true
    }
});

app.use(cors({
    origin: "https://asistentewhats.netlify.app",
    credentials: true
}));
let sock = null;
let lastQr = null;
let botReady = false;


const startWhatsAppClient = () => {
    if (sock || botReady) return;

    sock = makeWASocket({
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('📡 Generando QR...');
            const qr_png = qrcode.imageSync(qr, { type: 'png' });
            lastQr = `data:image/png;base64,${qr_png.toString('base64')}`;
            io.emit('qrCode', lastQr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Conexión cerrada, reconectando...', shouldReconnect);
            if (shouldReconnect) {
                startWhatsAppClient();
            } else {
                sock = null;
                botReady = false;
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot conectado!');
            botReady = true;
            io.emit('botReady', true);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && msg.message) {
            const messageType = Object.keys(msg.message)[0];
            const userId = msg.key.remoteJid;
            const userMessage = msg.message.conversation || msg.message[messageType].caption || '';

            if (userMessage.toLowerCase() === 'hola') {
                await sock.sendMessage(userId, { text: '👋 ¡Hola! Soy el asistente de WhatsApp.' });
                return;
            }

            if (['audioMessage', 'documentMessage', 'imageMessage', 'videoMessage'].includes(messageType)) {
                const warningMessage = "Por favor, no envíes audios ni archivos multimedia. Solo puedo responder a mensajes de texto.";
                await sock.sendMessage(userId, { text: warningMessage });
                return;
            }

            const response = await generateExternalLLMResponse(userId, userMessage);
            await sock.sendMessage(userId, { text: response });
        }
    });
};

async function generateExternalLLMResponse(userId, message) {
    try {
        const response = await axios.post(process.env.LLM_API_URL, { message });
        return response.data.outputCustomer.message || "Error al generar respuesta.";
    } catch (error) {
        console.error("❌ Error con LLM API:", error.message);
        return "Lo siento, hubo un error generando la respuesta.";
    }
}

io.on('connection', (socket) => {
    console.log('📡 Cliente conectado');

    socket.on("startQR", () => {
        if (!botReady) startWhatsAppClient();
    });

    if (lastQr && !botReady) {
        socket.emit('qrCode', lastQr);
    }

    const keepAliveInterval = setInterval(() => {
        socket.emit('ping', { message: 'Manteniendo conexión WebSocket' });
    }, 25000);

    socket.on('disconnect', () => {
        console.log('❌ Cliente desconectado');
        clearInterval(keepAliveInterval);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server en ejecución en http://localhost:${PORT}`);
});

