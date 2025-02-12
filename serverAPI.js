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
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// Configurar CORS con opciones extendidas
app.use(cors({
    origin: "http://localhost:5173",
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
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
        // Enviamos el QR como texto directamente
        lastQr = qr;
        io.emit('qrCode', qr);
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

        console.log('\n=== NUEVO MENSAJE RECIBIDO ==='.cyan);
        console.log('📱 De:', message.from);
        console.log('🤖 Bot:', botNumber);
        console.log('💬 Mensaje:', message.body);
        console.log('⏰ Hora:', new Date().toISOString());
        console.log('===============================\n'.cyan);

        if (message.from.includes('@g.us')) {
            console.log('❌ Mensaje de grupo ignorado'.yellow);
            return;
        }

        if (['audio', 'document', 'image', 'video'].includes(message.type)) {
            console.log('⚠️ Archivo multimedia detectado - enviando advertencia'.yellow);
            const warningMessage = "Por favor, no envíes audios ni archivos multimedia. Solo puedo responder a mensajes de texto.";
            await message.reply(warningMessage);
            return;
        }

        const userId = message.from;
        const userMessage = message.body.trim();
        
        if (userMessage.toLowerCase() === 'hola') {
            sessionCounter++;
            console.log('👋 Mensaje de saludo detectado - respondiendo...'.green);
            return message.reply(`👋 ¡Hola! Soy el asistente de WhatsApp. Mi número es ${botNumber}.`);
        }

        try {
            console.log('\n=== ENVIANDO A LLM API ==='.cyan);
            console.log('🔄 Preparando request con:');
            console.log({
                final_user: userId,
                customer: botNumber,
                sess_id: `session_${sessionCounter}`,
                message: userMessage
            });

            const response = await generateExternalLLMResponse({
                final_user: userId,
                customer: botNumber,
                sess_id: `session_${sessionCounter}`,
                message: userMessage
            });

            console.log('\n=== RESPUESTA RECIBIDA ==='.green);
            console.log('📨 Respuesta:', response);
            console.log('========================\n'.green);

            await message.reply(response);
            console.log('✅ Mensaje enviado exitosamente'.green);
        } catch (error) {
            console.error('\n=== ERROR ==='.red);
            console.error('❌ Error al procesar mensaje:', error);
            console.error('==============\n'.red);
            await message.reply("Lo siento, hubo un error al procesar tu mensaje.");
        }
    });

    client.initialize();
};

// Función para generar respuestas con LLM usando los nuevos parámetros
async function generateExternalLLMResponse({ final_user, customer, sess_id, message }) {
    try {
        const params = new URLSearchParams({
            final_user,
            customer,
            sess_id,
            message
        });

        console.log('\n=== LLAMADA A API ==='.cyan);
        console.log('🌐 URL:', process.env.LLM_API_URL);
        console.log('📎 Params:', params.toString());

        const response = await axios.post(`${process.env.LLM_API_URL}?${params}`, {}, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        console.log('\n=== RESPUESTA API ==='.cyan);
        console.log('📊 Status:', response.status);
        console.log('📦 Data:', JSON.stringify(response.data, null, 2));
        console.log('===================\n'.cyan);

        if (!response.data || !response.data.outputCustomer || !response.data.outputCustomer.message) {
            console.error('⚠️ Estructura de respuesta incorrecta:', response.data);
            throw new Error('Formato de respuesta no válido');
        }

        return response.data.outputCustomer.message;
    } catch (error) {
        console.error('\n=== ERROR EN API ==='.red);
        console.error('❌ Tipo de error:', error.name);
        console.error('❌ Mensaje:', error.message);
        if (error.response) {
            console.error('❌ Status:', error.response.status);
            console.error('❌ Data:', error.response.data);
        }
        console.error('===================\n'.red);
        throw error;
    }
}

// Añadir middleware para logging de Socket.IO
io.use((socket, next) => {
    console.log(`[Socket.IO] Nueva conexión intentando establecerse (${socket.id})`);
    console.log(`[Socket.IO] Transporte: ${socket.conn.transport.name}`);
    next();
});

// API para manejar WebSocket con mejor logging
io.on('connection', (socket) => {
    console.log(`[Socket.IO] Cliente conectado (${socket.id})`);
    console.log(`[Socket.IO] Usando transporte: ${socket.conn.transport.name}`);
    
    socket.on('disconnect', (reason) => {
        console.log(`[Socket.IO] Cliente desconectado (${socket.id}): ${reason}`);
    });

    socket.on('error', (error) => {
        console.error(`[Socket.IO] Error en socket (${socket.id}):`, error);
    });
    
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


