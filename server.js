const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, useSingleFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const axios = require('axios');
const cors = require('cors');
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
let botReady = false;

const startWhatsAppClient = async () => {
    if (sock || botReady) return;

    // Configuración del estado de autenticación en memoria
    const { state, saveCreds } = await useSingleFileAuthState();

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                if (err) {
                    console.error('Error generando QR:', err);
                } else {
                    io.emit('qrCode', url);
                }
            });
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

    sock.ev.on('messages.upsert', async (msg) => {
        const message = msg.messages[0];
        if (!message.message || message.key.fromMe) return;

        const messageType = Object.keys(message.message)[0];
        const userId = message.key.remoteJid;
        const userMessage = message.message.conversation || message.message.extendedTextMessage?.text || '';

        if (userId.includes('@g.us')) return;

        if (['audioMessage', 'documentMessage', 'imageMessage', 'videoMessage'].includes(messageType)) {
            const warningMessage = "Por favor, no envíes audios ni archivos multimedia. Solo puedo responder a mensajes de texto.";
            await sock.sendMessage(userId, { text: warningMessage });
            return;
        }

        if (userMessage.trim().toLowerCase() === 'hola') {
            await sock.sendMessage(userId, { text: '👋 ¡Hola! Soy el asistente de WhatsApp.' });
            return;
        }

        const response = await generateExternalLLMResponse(userId, userMessage);
        await sock.sendMessage(userId, { text: response });
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server en ejecución en http://localhost:${PORT}`);
});
