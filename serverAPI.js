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
        origin: true, // Allow all origins - you should restrict this in production
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
    origin: true, // Allow all origins - you should restrict this in production
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Variables de estado
let clients = new Map(); // Mapa para almacenar estados de clientes: { clientId: { client, ready, qr } }
const userSessions = new Map(); // Mapa para almacenar sesiones de usuarios

// Función para limpiar sesiones por cliente
function clearUserSessions(clientId) {
    const sessionCount = userSessions.size;
    if (clientId) {
        // Limpiar solo sesiones del cliente específico
        for (const [key, session] of userSessions.entries()) {
            if (session.clientId === clientId) {
                userSessions.delete(key);
            }
        }
    } else {
        userSessions.clear();
    }
    console.log(`\n=== LIMPIEZA DE SESIONES ===`.yellow);
    console.log(`🧹 Se limpiaron ${sessionCount} sesiones`);
    console.log(`==========================\n`.yellow);
}

// Configurar limpieza automática cada 24 horas
const HOURS_24 = 24 * 60 * 60 * 1000; // 24 horas en milisegundos
setInterval(() => {
    for (const [clientId] of clients) {
        clearUserSessions(clientId);
    }
}, HOURS_24);

// Ejecutar primera limpieza al inicio
console.log(`\n🔄 Programada limpieza automática de sesiones cada 24 horas\n`);

const startWhatsAppClient = (clientId, socket) => {
    const clientData = clients.get(clientId);
    if (clientData?.ready) {
        socket.emit('botReady', true);
        return;
    }

    const client = new Client({ 
        puppeteer: { 
            headless: true,
            args: ['--no-sandbox']
        } 
    });

    let qrAttempts = 0;
    const MAX_QR_ATTEMPTS = 5; // Número máximo de intentos de QR

    clients.set(clientId, {
        client,
        ready: false,
        qr: null,
        lastQrTime: null
    });

    client.on('qr', (qr) => {
        const clientData = clients.get(clientId);
        if (clientData.ready) {
            console.log('🛑 Cliente ya conectado, ignorando QR');
            return;
        }

        qrAttempts++;
        if (qrAttempts > MAX_QR_ATTEMPTS) {
            console.log('🔄 Máximo de intentos de QR alcanzado, reiniciando cliente...');
            client.destroy();
            clients.delete(clientId);
            socket.emit('authError', 'QR expirado, por favor intenta de nuevo');
            return;
        }
        
        console.log(`📱 Generando QR para cliente ${clientId} (intento ${qrAttempts})...`);
        const qr_png = qrcode.imageSync(qr, { type: 'png' });
        const qrBase64 = `data:image/png;base64,${qr_png.toString('base64')}`;
        
        clientData.qr = qrBase64;
        clientData.lastQrTime = Date.now();
        
        // Emitir el nuevo QR a todos los sockets conectados para este cliente
        io.emit(`qrCode_${clientId}`, qrBase64);
    });

    client.on('ready', () => {
        const clientData = clients.get(clientId);
        if (!clientData) return;

        clientData.ready = true;
        clientData.qr = null; // Limpiar QR al conectar
        clientData.lastQrTime = null;
        qrAttempts = 0; // Resetear contador de intentos

        console.log(`✅ WhatsApp Bot conectado para cliente ${clientId}!`);
        io.emit(`botReady_${clientId}`, true);
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Error de autenticación:', msg);
        socket.emit('authError', 'Error de autenticación, por favor reinicia.');
    });

    client.on('message', async (message) => {
        if (!clientData.ready || !client.info) return;
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
                clientId,
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

    client.initialize().catch(err => {
        console.error(`❌ Error inicializando cliente ${clientId}:`, err);
        clients.delete(clientId);
        socket.emit('authError', 'Error iniciando WhatsApp');
    });
};

// Función para generar respuestas con LLM usando los nuevos parámetros
async function generateExternalLLMResponse({ clientId, final_user, customer, sess_id, message }) {
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
            const sess_server = `${clientId}_${final_user}_${response.data.sess_id}`;
            userSessions.set(final_user, {
                clientId,
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
    
    socket.on("startQR", ({ clientId }) => {
        if (!clientId) {
            socket.emit('authError', 'Client ID is required');
            return;
        }

        console.log(`🔄 Iniciando/Recuperando QR para cliente ${clientId}`);
        
        const clientData = clients.get(clientId);
        if (clientData) {
            if (clientData.ready) {
                socket.emit('botReady', true);
            } else if (clientData.qr && Date.now() - clientData.lastQrTime < 60000) {
                // Enviar QR almacenado solo si tiene menos de 1 minuto
                socket.emit('qrCode', clientData.qr);
            } else {
                // Si el QR es viejo o no existe, iniciar nuevo cliente
                startWhatsAppClient(clientId, socket);
            }
        } else {
            startWhatsAppClient(clientId, socket);
        }
    });
});

// Iniciar el servidor
const PORT = 3001;
server.listen(PORT, () => {  
    console.log(`🚀 Server en ejecución en http://localhost:${PORT}`);
});
