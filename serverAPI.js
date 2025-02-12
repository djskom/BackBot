require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('whatsapp-web.js');
const qrcode = require('qr-image');
const axios = require('axios');
const cors = require('cors');

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

// Variables de estado
let clients = new Map();
const userSessions = new Map();

// Función para limpiar sesiones cada 24 horas
const HOURS_24 = 24 * 60 * 60 * 1000;
setInterval(() => {
    const sessionCount = userSessions.size;
    userSessions.clear();
    console.log(`🧹 Se limpiaron ${sessionCount} sesiones`);
}, HOURS_24);

const startWhatsAppClient = (clientId, socket) => {
    if (clients.has(clientId)) {
        const clientData = clients.get(clientId);
        if (clientData.ready) return;
    }

    const client = new Client({ puppeteer: { headless: true } });
    
    clients.set(clientId, {
        client,
        ready: false,
        qr: null
    });

    client.on('qr', (qr) => {
        const clientData = clients.get(clientId);
        if (clientData.ready) return;
        
        console.log('📡 Generando QR...');
        const qr_png = qrcode.imageSync(qr, { type: 'png' });
        clientData.qr = `data:image/png;base64,${qr_png.toString('base64')}`;
        socket.emit('qrCode', clientData.qr);
    });

    client.on('ready', () => {
        const clientData = clients.get(clientId);
        clientData.ready = true;
        console.log('✅ WhatsApp Bot conectado!');
        socket.emit('botReady', true);
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Error de autenticación:', msg);
        socket.emit('authError', 'Error de autenticación, por favor reinicia.');
    });

    client.on('message', async (message) => {
        const clientData = clients.get(clientId);
        if (!clientData.ready || !client.info) return;
        const botNumber = client.info.wid.user;

        if (message.from.includes('@g.us')) return;

        if (['audio', 'document', 'image', 'video'].includes(message.type)) {
            await message.reply("Por favor, no envíes audios ni archivos multimedia. Solo puedo responder a mensajes de texto.");
            return;
        }

        const userId = message.from;
        const userMessage = message.body.trim();
        
        if (userMessage.toLowerCase() === 'hola') {
            return message.reply(`👋 ¡Hola! Soy el asistente de WhatsApp. Mi número es ${botNumber}.`);
        }

        try {
            const userSession = userSessions.get(userId);
            const sess_id = userSession?.sess_id || null;

            const response = await generateExternalLLMResponse({
                clientId,
                final_user: userId,
                customer: botNumber,
                sess_id,
                message: userMessage
            });

            message.reply(response);
        } catch (error) {
            console.error("❌ Error:", error);
            message.reply("Lo siento, hubo un error al procesar tu mensaje.");
        }
    });

    client.initialize().catch(err => {
        console.error(`Error inicializando cliente ${clientId}:`, err);
        socket.emit('authError', 'Error iniciando WhatsApp');
    });
};

async function generateExternalLLMResponse({ clientId, final_user, customer, sess_id, message }) {
    try {
        const params = new URLSearchParams({
            final_user: final_user.replace('@c.us', ''),
            customer,
            sess_id: sess_id || null,
            message
        });

        const response = await axios.post(`${process.env.LLM_API_URL}?${params}`, '', {
            headers: {
                'accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        if (response.data.sess_id) {
            userSessions.set(final_user, {
                clientId,
                sess_id: response.data.sess_id,
                sess_server: `${clientId}_${final_user}_${response.data.sess_id}`
            });
        }

        return response.data.risposta || "Error al generar respuesta.";
    } catch (error) {
        console.error("❌ Error con LLM API:", error.message);
        throw error;
    }
}

io.on('connection', (socket) => {
    console.log('📡 Cliente conectado');
    
    socket.on("startQR", ({ clientId }) => {
        if (!clientId) {
            socket.emit('authError', 'Client ID is required');
            return;
        }

        const clientData = clients.get(clientId);
        if (clientData) {
            if (clientData.ready) {
                socket.emit('botReady', true);
            } else if (clientData.qr) {
                socket.emit('qrCode', clientData.qr);
            }
        } else {
            startWhatsAppClient(clientId, socket);
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Server en ejecución en http://localhost:${PORT}`);
});
