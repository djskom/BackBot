const express = require('express');
const http = require('http');  // Importar http
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
let client = null;
let lastQr = null;
let botReady = false;

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
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Error de autenticación:', msg);
        io.emit('authError', 'Error de autenticación, por favor reinicia.');
    });

    client.on('message', async (message) => {
        if (!botReady || !client.info) return;  // Verificar que el cliente está listo
        const botNumber = client.info.wid.user; // Extraer el número del bot
    
        console.log(`🤖 Mensaje recibido en el bot (${botNumber}):`, message.body);
    
        if (message.from.includes('@g.us')) return; // Ignorar grupos
    
        if (['audio', 'document', 'image', 'video'].includes(message.type)) {
            const warningMessage = "Por favor, no envíes audios ni archivos multimedia. Solo puedo responder a mensajes de texto.";
            await message.reply(warningMessage);
            return;
        }
    
        const userId = message.from;
        const userMessage = message.body.trim();
        
        if (userMessage.toLowerCase() === 'hola') {
            return message.reply(`👋 ¡Hola! Soy el asistente de WhatsApp. Mi número es ${botNumber}.`);
        }
    
        const response = await generateExternalLLMResponse(userId, userMessage);
        message.reply(response);
    });
    

    client.initialize();
};

// Función para generar respuestas con LLM
async function generateExternalLLMResponse(userId, message) {
    try {
        const response = await axios.post(process.env.LLM_API_URL, { message });
        return response.data.outputCustomer.message || "Error al generar respuesta.";
    } catch (error) {
        console.error("❌ Error con LLM API:", error.message);
        return "Lo siento, hubo un error generando la respuesta.";
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
});

// Iniciar el servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {  // Usar `server.listen` en lugar de `app.listen`
    console.log(`🚀 Server en ejecución en http://localhost:${PORT}`);
});
