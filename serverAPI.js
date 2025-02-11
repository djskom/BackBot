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
        origin: "http://localhost:5173",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Configurar CORS
app.use(cors({
    origin: "http://localhost:5173",
    credentials: true
}));

// Variables de estado
let client = null;
let lastQr = null;
let botReady = false;
let sessionCounter = 0;

const startWhatsAppClient = () => {
    if (client || botReady) return;

    client = new Client({ puppeteer: { headless: true } });

    client.on('qr', (qr) => {
        if (botReady) return;
        console.log('📡 Generando QR...');
        const qr_png = qrcode.imageSync(qr, { type: 'png' });
        lastQr = `data:image/png;base64,${qr_png.toString('base64')}`;
        io.emit('qrCode', lastQr);
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Bot conectado!');
        botReady = true;
        io.emit('botReady', true);
        sessionCounter = 0; // Reset session counter on new connection
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Error de autenticación:', msg);
        io.emit('authError', 'Error de autenticación, por favor reinicia.');
    });

    client.on('message', async (message) => {
        if (!botReady || !client.info) return;
        const botNumber = client.info.wid.user;

        console.log(`🤖 Mensaje recibido en el bot (${botNumber}):`, message.body);

        if (message.from.includes('@g.us')) return;

        if (['audio', 'document', 'image', 'video'].includes(message.type)) {
            const warningMessage = "Por favor, no envíes audios ni archivos multimedia. Solo puedo responder a mensajes de texto.";
            await message.reply(warningMessage);
            return;
        }

        const userId = message.from;
        const userMessage = message.body.trim();
        
        if (userMessage.toLowerCase() === 'hola') {
            sessionCounter++;
            return message.reply(`👋 ¡Hola! Soy el asistente de WhatsApp. Mi número es ${botNumber}.`);
        }

        try {
            const response = await generateExternalLLMResponse({
                final_user: userId,
                customer: botNumber,
                sess_id: `session_${sessionCounter}`,
                message: userMessage
            });
            await message.reply(response);
        } catch (error) {
            console.error('Error al procesar mensaje:', error);
            await message.reply("Lo siento, hubo un error al procesar tu mensaje.");
        }
    });

    client.initialize();
};

// Función para generar respuestas con LLM usando los nuevos parámetros
async function generateExternalLLMResponse({ final_user, customer, sess_id, message }) {
    try {
        const response = await axios.post(process.env.LLM_API_URL, {
            final_user,
            customer,
            sess_id,
            message
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.data) {
            throw new Error('Respuesta vacía del servidor LLM');
        }

        return response.data;
    } catch (error) {
        console.error("❌ Error con LLM API:", error.message);
        if (error.response?.status === 405) {
            console.error("Error: Método HTTP no permitido");
            throw new Error("Error de configuración del API: Método no permitido");
        }
        if (error.response?.data?.detail) {
            console.error("Validation Error:", error.response.data.detail);
        }
        throw new Error("Error al generar respuesta del LLM");
    }
}

// API para manejar WebSocket
io.on('connection', (socket) => {
    console.log('📡 Cliente conectado');
    
    socket.on("startQR", () => {
        if (!botReady) startWhatsAppClient();
    });
    
    if (lastQr && !botReady) {
        socket.emit('qrCode', lastQr);
    }
    
    if (botReady) {
        socket.emit('botReady', true);
    }
});

// Iniciar el servidor
const PORT = 3001;
server.listen(PORT, () => {  
    console.log(`🚀 Server en ejecución en http://localhost:${PORT}`);
});
