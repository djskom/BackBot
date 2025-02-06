const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qr-image');
const axios = require('axios');
const cors = require('cors');
const { Boom } = require('@hapi/boom');
const path = require('path');

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

    // Initialize the auth state
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // Create the socket with auth state
    sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        // Add browser description for better connection stability
        browser: ['Asistente WhatsApp', 'Chrome', '1.0.0']
    });

    // Listen for credentials updates
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qr_png = qrcode.imageSync(qr, { type: 'png' });
            const qrDataUrl = `data:image/png;base64,${qr_png.toString('base64')}`;
            io.emit('qrCode', qrDataUrl);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error instanceof Boom && 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Conexión cerrada, reconectando...', shouldReconnect);
            
            if (shouldReconnect) {
                startWhatsAppClient();
            } else {
                sock = null;
                botReady = false;
                // Clear auth state if logged out
                require('fs').rmSync('auth_info_baileys', { recursive: true, force: true });
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
        const userMessage = message.message.conversation || 
                          message.message.extendedTextMessage?.text || '';

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

        try {
            const response = await generateExternalLLMResponse(userId, userMessage);
            await sock.sendMessage(userId, { text: response });
        } catch (error) {
            console.error('Error sending message:', error);
            await sock.sendMessage(userId, { 
                text: 'Lo siento, ocurrió un error al procesar tu mensaje.' 
            });
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server en ejecución en http://localhost:${PORT}`);
});
