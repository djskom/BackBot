require('dotenv').config(); 
const express = require('express');
const https = require('https');
const { Server } = require('socket.io');
const { Client } = require('whatsapp-web.js');
const qrcode = require('qr-image');
const axios = require('axios');

const cors = require('cors');
const fs = require('fs');

const app = express();

// Configuración HTTPS
const httpsOptions = {
    key: fs.readFileSync('./cert/key.pem'),
    cert: fs.readFileSync('./cert/cert.pem')
};

// Crear servidor HTTPS en lugar de HTTP
const server = https.createServer(httpsOptions, app);

// Configurar CORS para HTTPS
const io = new Server(server, {
    cors: {
        origin: "https://localhost:5173",
        methods: ["GET", "POST"],
        credentials: true
    }
});

app.use(cors({
    origin: "https://localhost:5173",
    credentials: true
}));
app.use(express.json());

// Variables de estado
let client = null;
let lastQr = null;
let botReady = false;
let generatingQR = false;

// Mapa para el historial de conversaciones
const conversations = new Map();

// Función para inicializar WhatsApp
const startWhatsAppClient = () => {
    if (client || botReady) return;

    client = new Client({
        puppeteer: { headless: true }
    });

    client.on('qr', (qr) => {
        if (botReady){
            generatingQR = false;
            console.log('stop qr generation');   
            return;
        }
        console.log('📡 Generando QR Code...');

        const qr_png = qrcode.imageSync(qr, { type: 'png' });
        lastQr = `data:image/png;base64,${qr_png.toString('base64')}`;

        io.emit('qrCode', lastQr);
        
        generatingQR = false;
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Bot conectado!');
        botReady = true;
        generatingQR = false;
        console.log('stop qr generation2');
        io.emit('botReady', true);
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Error de autenticación:', msg);
        io.emit('authError', 'Error de autenticación, por favor reinicia.');
    });

    client.on('message', async (message) => {
        console.log(`📩 Mensaje recibido de ${message.from}: ${message.body}`);
    
        // Verificar si el mensaje proviene de un grupo
        if (message.from.includes('@g.us')) {
            console.log("Mensaje de grupo, ignorado");
            return;
        }
    
        // Verificar si el mensaje es de tipo audio o multimedia
        if (message.type === 'audio' || message.type === 'document' || message.type === 'image' || message.type === 'video') {
            const warningMessage = "Por favor, no envíes audios ni archivos multimedia. Solo puedo responder a mensajes de texto.";
    
            // Enviar advertencia al usuario
            await message.reply(warningMessage);
            return;
        }
    
        const userId = message.from;
        const userMessage = message.body.trim();
    
        // Respuesta automática"
        if (userMessage.toLowerCase() === 'hola') {
            return message.reply('👋 ¡Hola! Soy el asistente de WhatsApp. ¿En qué puedo ayudarte?');
        }
    
        // Generar respuesta usando la API externa
        const response = await generateExternalLLMResponse(userId, userMessage);
        message.reply(response);
    });
    

    client.initialize();
};

// Función para obtener respuesta de LLM API con historial de conversación
async function generateExternalLLMResponse(userId, message) {
    try {
        if (!conversations.has(userId)) {
            conversations.set(userId, []);
        }

        // Agregar el mensaje del usuario al historial
        const history = conversations.get(userId);
        history.push({ role: 'user', content: message });

        // Llamada a la API externa desde variable de entorno
        const response = await axios.post(process.env.LLM_API_URL, {
            message: message
        });

        const aiResponse = response.data.outputCustomer.message;
        
        if (!aiResponse) {
            throw new Error("La API externa no generó una respuesta válida.");
        }

        // Guardamos la respuesta en la conversación
        history.push({ role: 'assistant', content: aiResponse });

        return aiResponse;
    } catch (error) {
        console.error("❌ Error con LLM API:", error.message);
        return "Lo siento, hubo un error generando la respuesta.";
    }
}

// WebSocket para manejar eventos desde el frontend
io.on('connection', (socket) => {
    console.log('📡 Cliente conectado al socket.');

    socket.on("startQR", () => {
        if (!generatingQR && !botReady) {
            generatingQR = true;
            console.log("🟢 Iniciando generación de QR...");
            startWhatsAppClient();
        }
    });

    // Si hay un QR almacenado, enviarlo al nuevo cliente
    if (lastQr && !botReady) {
        socket.emit('qrCode', lastQr);
    }
});

// API para enviar mensajes desde el backend
app.post('/send', async (req, res) => {
    if (!botReady) {
        return res.status(400).json({ error: "El bot no está conectado aún." });
    }

    const { number, message } = req.body;
    if (!number || !message) {
        return res.status(400).json({ error: "Número y mensaje son requeridos." });
    }

    try {
        await client.sendMessage(`${number}@c.us`, message);
        res.json({ success: true, message: "Mensaje enviado correctamente." });
    } catch (error) {
        console.error("❌ Error enviando mensaje:", error);
        res.status(500).json({ error: "No se pudo enviar el mensaje." });
    }
});

// API para verificar el estado del bot
app.get('/status', (req, res) => {
    res.json({ status: "Servidor en ejecución", botReady });
});

// Iniciar el servidor
server.listen(3001, () => {
    console.log('🚀 Server en ejecución en http://localhost:3001');
});
