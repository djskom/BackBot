require('dotenv').config();  // Añadir al inicio del archivo
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
const userSessions = new Map(); // Mapa para almacenar sesiones de usuarios

// Función para limpiar sesiones
function clearUserSessions() {
    const sessionCount = userSessions.size;
    userSessions.clear();
    console.log(`\n=== LIMPIEZA DE SESIONES ===`.yellow);
    console.log(`🧹 Se limpiaron ${sessionCount} sesiones`);
    console.log(`⏰ Próxima limpieza en 24 horas`);
    console.log(`==========================\n`.yellow);
}

// Configurar limpieza automática cada 24 horas
const HOURS_24 = 24 * 60 * 60 * 1000; // 24 horas en milisegundos
setInterval(clearUserSessions, HOURS_24);

// Ejecutar primera limpieza al inicio
console.log(`\n🔄 Programada limpieza automática de sesiones cada 24 horas\n`);

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
            await client.sendMessage(message.from, warningMessage);
            return;
        }

        const userId = message.from;
        const userMessage = message.body.trim();
        
        if (userMessage.toLowerCase() === 'hola') {
            sessionCounter++;
            console.log('👋 Mensaje de saludo detectado - respondiendo...'.green);
            await client.sendMessage(message.from, `👋 ¡Hola! Soy el asistente de WhatsApp. Mi número es ${botNumber}.`);
            return;
        }

        try {
            // Obtener la sesión existente o usar null para nuevo usuario
            const userSession = userSessions.get(userId);
            const sess_id = userSession ? userSession.sess_id : null;

            console.log('\n=== ENVIANDO A LLM API ==='.cyan);
            console.log('🔄 Preparando request con:');
            console.log({
                final_user: userId,
                customer: botNumber,
                sess_id: sess_id,
                message: userMessage
            });

            const response = await generateExternalLLMResponse({
                final_user: userId,
                customer: botNumber,
                sess_id: sess_id,
                message: userMessage
            });

            console.log('\n=== RESPUESTA RECIBIDA ==='.green);
            console.log('📨 Respuesta:', response);
            console.log('========================\n'.green);

            await client.sendMessage(message.from, response);
            console.log('✅ Mensaje enviado exitosamente'.green);
        } catch (error) {
            console.error('\n=== ERROR ==='.red);
            console.error('❌ Error al procesar mensaje:', error);
            console.error('==============\n'.red);
            await client.sendMessage(message.from, "Lo siento, hubo un error al procesar tu mensaje.");
        }
    });

    client.initialize();
};

// Función para generar respuestas con LLM usando los nuevos parámetros
async function generateExternalLLMResponse({ final_user, customer, sess_id, message }) {
    try {
        if (!process.env.LLM_API_URL) {
            console.error('\n=== ERROR DE CONFIGURACIÓN ==='.red);
            console.error('❌ LLM_API_URL no está definida en las variables de entorno');
            throw new Error('URL del API no configurada');
        }

        // Sanear los parámetros
        const params = new URLSearchParams({
            final_user: final_user.replace('@c.us', ''), // Remover @c.us del número
            customer: customer,                          // Número del bot
            sess_id: sess_id || null, // Permitir null en primer mensaje
            message: message
        });

        console.log('\n=== LLAMADA A API ==='.cyan);
        console.log('🌐 URL:', process.env.LLM_API_URL);
        console.log('📎 Params:', params.toString());

        const apiUrl = new URL(process.env.LLM_API_URL);
        console.log('🔍 URL completa:', `${apiUrl}?${params}`);

        const response = await axios.post(`${apiUrl}?${params}`, '', {
            headers: {
                'accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });
        
        console.log('\n=== RESPUESTA API ==='.cyan);
        console.log('📊 Status:', response.status);
        console.log('📦 Data:', JSON.stringify(response.data, null, 2));
        console.log('===================\n'.cyan);

        // La respuesta ahora viene en el campo "risposta"
        if (!response.data || !response.data.risposta) {
            console.error('⚠️ Estructura de respuesta incorrecta:', response.data);
            throw new Error('Formato de respuesta no válido');
        }

        // Guardar sess_id si viene en la respuesta
        if (response.data.sess_id) {
            const sess_server = `${final_user}_${response.data.sess_id}`;
            userSessions.set(final_user, {
                sess_id: response.data.sess_id,
                sess_server: sess_server
            });
            console.log(`📝 Nueva sesión creada: ${sess_server}`);
        }

        return response.data.risposta;
    } catch (error) {
        if (error.response?.status === 422) {
            console.error('\n=== ERROR DE VALIDACIÓN ==='.red);
            console.error('❌ Detalles:', JSON.stringify(error.response.data.detail, null, 2));
        } else if (error.code === 'ERR_INVALID_URL') {
            console.error('\n=== ERROR DE CONFIGURACIÓN ==='.red);
            console.error('❌ La URL del API no es válida:', process.env.LLM_API_URL);
        }
        
        console.error('\n=== ERROR EN API ==='.red);
        console.error('❌ Tipo de error:', error.name);
        console.error('❌ Mensaje:', error.message);
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
