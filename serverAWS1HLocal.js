require('dotenv').config();
const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path'); // Add path module
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js'); // Import LocalAuth
const qrcode = require('qr-image');
const axios = require('axios');
const cors = require('cors');
require('colors');
const { createClient } = require('@supabase/supabase-js');

// Create sessions directory if it doesn't exist
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log(`📁 Created sessions directory: ${SESSIONS_DIR}`.green);
}

// Supabase initialization
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const MESSAGE_TIMEOUT = 15 * 1000; // 15 segundos en milisegundos

// Simplified SSL configuration
const options = {
    key: fs.readFileSync('/opt/bitnami/apache2/conf/www.vnatgroup.com.key'),
    cert: fs.readFileSync('/opt/bitnami/apache2/conf/www.vnatgroup.com.crt'),
    // Remove problematic options, keep it simple
};

const app = express();
const server = https.createServer(options, app);

// Add health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Updated Socket.IO configuration
const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || 'https://vnat23asistant.netlify.app',
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 30000, // Reduced timeout
    pingInterval: 10000, // More frequent pings
    transports: ['websocket'],
    allowEIO3: true,
    maxHttpBufferSize: 1e8,
    path: '/socket.io/'
});

// Configurar CORS con opciones extendidas
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'https://vnat23asistant.netlify.app',
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Variables de estado
let clients = new Map(); // Mapa para almacenar estados de clientes: { clientId: { client, ready, qr } }
// Modificar la estructura de userSessions para incluir timestamp
const userSessions = new Map(); // { final_user: { clientId, sess_id, sess_server, lastActivity } }
const messageBuffers = new Map(); // Mapa para almacenar buffers de mensajes por usuario
const messageTimers = new Map(); // Mapa para almacenar temporizadores de mensajes por usuario

// Función modificada para limpiar sesiones basada en timestamp
function clearUserSessions(clientId) {
    const now = Date.now();
    const HOURS_1 = 1 * 60 * 60 * 1000; // 1 hora en milisegundos
    let cleanedCount = 0;
    const cleanedSessions = [];

    for (const [userId, session] of userSessions.entries()) {
        if (session.clientId === clientId && 
            (now - session.lastActivity) > HOURS_1) {
            // Guardar información de la sesión antes de eliminarla
            cleanedSessions.push({
                userId: userId,
                sessionId: session.sess_id,
                serverSession: session.sess_server,
                inactiveTime: Math.round((now - session.lastActivity) / (60 * 60 * 1000)) + ' horas'
            });
            userSessions.delete(userId);
            cleanedCount++;
        }
    }

    if (cleanedCount > 0) {
        console.log(`\n=== LIMPIEZA DE SESIONES ===`.yellow);
        console.log(`🧹 Se limpiaron ${cleanedCount} sesiones inactivas por más de 1 hora`);
        console.log('📋 Detalle de sesiones eliminadas:');
        cleanedSessions.forEach((sess, idx) => {
            console.log(`   ${idx + 1}. Usuario: ${sess.userId}`);
            console.log(`      ID Sesión: ${sess.sessionId}`);
            console.log(`      Sesión Servidor: ${sess.serverSession}`);
            console.log(`      Tiempo inactivo: ${sess.inactiveTime}`);
        });
        console.log(`==========================\n`.yellow);
    }
}

// Configurar limpieza automática cada 15 minutos
const MINUTES_15 = 15 * 60 * 1000; // 15 minutos en milisegundos
setInterval(() => {
    console.log('\n=== CONTROL DE LIMPIEZA ==='.cyan);
    console.log('⏰ Hora:', new Date().toISOString());
    console.log('🔍 Revisando sesiones activas...');
    
    for (const [clientId] of clients) {
        console.log(`👥 Revisando cliente: ${clientId}`);
        clearUserSessions(clientId);
    }
    
    console.log('✅ Control de limpieza completado');
    console.log('==========================\n'.cyan);
}, MINUTES_15);

// Ejecutar primera limpieza al inicio
console.log(`\n🔄 Programada limpieza automática de sesiones cada 15 minutos\n`);

const startWhatsAppClient = (clientId, socket) => {
    const clientData = clients.get(clientId);
    if (clientData?.ready) {
        socket.emit('botReady', true);
        return;
    }

    // Create a specific directory for this client's session
    const clientSessionDir = path.join(SESSIONS_DIR, clientId);
    if (!fs.existsSync(clientSessionDir)) {
        fs.mkdirSync(clientSessionDir, { recursive: true });
        console.log(`📁 Created client session directory: ${clientSessionDir}`.green);
    }

    // Initialize client with LocalAuth
    const client = new Client({ 
        puppeteer: { 
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run'
            ],
            timeout: 0 // Disable timeout to prevent disconnections
        },
        authStrategy: new LocalAuth({
            clientId: clientId,
            dataPath: SESSIONS_DIR
        })
    });

    // Inicializar datos del cliente
    clients.set(clientId, {
        client,
        ready: false,
        qr: null
    });

    // Log session status
    console.log(`\n=== INICIANDO CLIENTE WHATSAPP ===`.cyan);
    console.log(`🆔 Cliente ID: ${clientId}`);
    console.log(`📂 Usando LocalAuth en: ${clientSessionDir}`);
    console.log(`⏱️ Hora: ${new Date().toISOString()}`);
    console.log(`============================\n`.cyan);

    client.on('qr', (qr) => {
        const clientData = clients.get(clientId);
        if (clientData.ready) return;
        
        console.log('📡 Generando nuevo QR...');
        const qr_png = qrcode.imageSync(qr, { type: 'png' });
        const qrBase64 = `data:image/png;base64,${qr_png.toString('base64')}`;
        
        // Actualizar el QR más reciente
        clientData.qr = qrBase64;
        // Emitir el nuevo QR a todos los clientes
        io.emit('qrCode', qrBase64);
    });

    client.on('ready', () => {
        const clientData = clients.get(clientId);
        if (!clientData) return;

        console.log('✅ WhatsApp Bot conectado!');
        clientData.ready = true;
        clientData.qr = null; // Limpiar QR una vez conectado
        io.emit('botReady', true);
    });

    client.on('authenticated', () => {
        console.log(`\n=== CLIENTE AUTENTICADO ===`.green);
        console.log(`🆔 Cliente ID: ${clientId}`);
        console.log(`⏱️ Hora: ${new Date().toISOString()}`);
        console.log(`=========================\n`.green);
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Error de autenticación:', msg);
        socket.emit('authError', 'Error de autenticación, por favor reinicia.');
    });

    client.on('disconnected', (reason) => {
        console.error(`\n=== CLIENTE DESCONECTADO ===`.red);
        console.error(`🆔 Cliente ID: ${clientId}`);
        console.error(`❌ Razón: ${reason}`);
        console.error(`⏱️ Hora: ${new Date().toISOString()}`);
        console.error(`=========================\n`.red);
        
        // Remove client from the map but don't delete the session files
        clients.delete(clientId);
        socket.emit('authError', 'Cliente desconectado, por favor reconecta.');
        
        // Wait a bit before attempting to reconnect
        setTimeout(() => {
            console.log(`🔄 Intentando reconectar cliente ${clientId}...`);
            startWhatsAppClient(clientId, socket);
        }, 5000); // Wait 5 seconds before reconnecting
    });

    client.on('message', async (message) => {
        const clientData = clients.get(clientId);
        if (!clientData || !clientData.ready || !client.info) return;
        const botNumber = client.info.wid.user;
        
        // Check if the message is from a status broadcast
        if (message.from === 'status@broadcast') {
            console.log('\n=== STATUS BROADCAST IGNORADO ==='.yellow);
            console.log('❌ Ignorando mensaje de status broadcast');
            console.log('================================\n'.yellow);
            return;
        }
        
        // Check if the message is from the bot itself
        if (message.from.replace('@c.us', '') === botNumber) {
            console.log('\n=== MESSAGGIO IN USCITA DA SCARTARE ==='.yellow);
            console.log('❌ Ignorando mensaje del propio bot');
            console.log('================================\n'.yellow);
            return;
        }

        console.log('\n=== NUEVO MENSAJE RECIBIDO ==='.cyan);
        console.log('📱 De:', message.from);
        console.log('🤖 Bot:', botNumber);
        console.log('💬 Mensaje:', message.body);
        console.log('⏰ Hora:', new Date().toISOString());
        console.log('===============================\n'.cyan);
        console.log('message', message);
        console.log('===============================\n'.cyan);

        if (message.from.includes('@g.us')) {
            console.log('❌ Mensaje de grupo ignorado'.yellow);
            return;
        }

        // Check if user is blacklisted
        const isBlacklisted = await isUserBlacklisted(message.from, botNumber);
        if (isBlacklisted) {
            console.log(`❌ Usuario ${message.from} está en la lista negra - ignorando mensaje`.yellow);
            return;
        }

        // Add test mode check after blacklist check
        const shouldProcess = await shouldProcessMessage(message.from, botNumber);
        if (!shouldProcess) {
            console.log(`❌ Usuario ${message.from} no está en lista de test - ignorando mensaje en modo test`.yellow);
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
            console.log('👋 Mensaje de saludo detectado - respondiendo...'.green);
            await client.sendMessage(message.from, `👋 ¡Hola! Soy el asistente de WhatsApp. Mi número es ${botNumber}.`);
            return;
        }

        // Concatenar mensajes recibidos dentro de 15 segundos
        if (!messageBuffers.has(userId)) {
            messageBuffers.set(userId, []);
        }
        messageBuffers.get(userId).push(userMessage);

        if (messageTimers.has(userId)) {
            clearTimeout(messageTimers.get(userId));
        }

        messageTimers.set(userId, setTimeout(async () => {
            const concatenatedMessage = messageBuffers.get(userId).join(' ');
            messageBuffers.delete(userId);
            messageTimers.delete(userId);

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
                    message: concatenatedMessage
                });

                const response = await generateExternalLLMResponse({
                    clientId,
                    final_user: userId,
                    customer: botNumber,
                    sess_id: sess_id,
                    message: concatenatedMessage
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
                
                // Intenta mantener la sesión incluso en caso de error
                try {
                    await client.sendMessage(message.from, "Mi dispiace, c'è stato un errore nell'elaborazione del tuo messaggio. Potresti riprovare?");
                } catch (sendError) {
                    console.error('❌ Error adicional al enviar mensaje de error:', sendError);
                }
            }
        }, MESSAGE_TIMEOUT));
    });

    // Initialize with better error handling
    client.initialize()
        .then(() => {
            console.log(`✅ Cliente ${clientId} inicializado correctamente`);
        })
        .catch(err => {
            console.error(`\n=== ERROR INICIALIZANDO CLIENTE ===`.red);
            console.error(`🆔 Cliente ID: ${clientId}`);
            console.error(`❌ Error: ${err.message}`);
            console.error(`📚 Stack: ${err.stack}`);
            console.error(`⏱️ Hora: ${new Date().toISOString()}`);
            console.error(`===============================\n`.red);
            
            clients.delete(clientId);
            socket.emit('authError', 'Error iniciando WhatsApp, por favor intenta nuevamente.');
            
            // Check if error is related to existing browser session
            if (err.message.includes('browser')) {
                console.log('🔄 Detectado problema con browser, limpiando sesión...');
                // You could implement session cleanup here if needed
            }
        });
};

// Add this function to check blacklist
async function isUserBlacklisted(finalUser, botNumber) {
    try {
        // Normalize function for all phone numbers
        const normalizeNumber = (num) => {
            return String(num)
                .replace('@c.us', '')  // Remove @c.us
                .replace(/^\+/, '')    // Remove leading + if exists
                .trim();               // Remove whitespace
        };

        // Normalize both numbers
        const normalizedBotNumber = normalizeNumber(botNumber);
        const normalizedUserNumber = normalizeNumber(finalUser);

        console.log(`\n=== CHECKING BLACKLIST ===`);
        console.log(`🔍 Original bot number: ${botNumber}`);
        console.log(`🔍 Normalized bot number: ${normalizedBotNumber}`);
        console.log(`👤 Original user number: ${finalUser}`);
        console.log(`👤 Normalized user number: ${normalizedUserNumber}`);
        
        const { data, error } = await supabase
            .from('clients')
            .select('blacklist')
            .eq('final_user', normalizedBotNumber)
            .single();

        if (error) {
            console.error('Error querying blacklist:', error);
            return false;
        }

        if (!data || !data.blacklist) {
            console.log('❌ No blacklist found for bot number:', normalizedBotNumber);
            return false;
        }

        // Ensure blacklist is an array
        const blacklist = Array.isArray(data.blacklist) ? data.blacklist : [];
        
        console.log('📋 Original blacklist:', blacklist);

        // Normalize all numbers in blacklist
        const normalizedBlacklist = blacklist
            .map(num => normalizeNumber(num))
            .filter(Boolean); // Remove any empty strings

        console.log('📋 Normalized blacklist:', normalizedBlacklist);
        console.log('🔍 Checking if number exists:', normalizedUserNumber);

        // Check if the normalized number is in the normalized blacklist
        const isBlocked = normalizedBlacklist.includes(normalizedUserNumber);
        console.log(`${isBlocked ? '🚫' : '✅'} User ${normalizedUserNumber} is ${isBlocked ? 'blocked' : 'not blocked'}`);
        console.log(`===========================\n`);
        
        return isBlocked;
    } catch (error) {
        console.error('Error in blacklist check:', error);
        console.error('Stack:', error.stack);
        return false;
    }
}

// Add this function to check if a message should be processed based on test configuration
async function shouldProcessMessage(finalUser, botNumber) {
    try {
        // Normalize function for all phone numbers
        const normalizeNumber = (num) => {
            return String(num)
                .replace('@c.us', '')  // Remove @c.us
                .replace(/^\+/, '')    // Remove leading + if exists
                .trim();               // Remove whitespace
        };

        // Normalize both numbers
        const normalizedBotNumber = normalizeNumber(botNumber);
        const normalizedUserNumber = normalizeNumber(finalUser);

        console.log(`\n=== CHECKING TEST MODE ===`);
        console.log(`🔍 Bot number: ${normalizedBotNumber}`);
        console.log(`👤 User number: ${normalizedUserNumber}`);
        
        const { data, error } = await supabase
            .from('clients')
            .select('test')
            .eq('final_user', normalizedBotNumber)
            .single();

        if (error) {
            console.error('Error querying test numbers:', error);
            return true; // On error, process message by default
        }

        // If no test numbers are defined, process all messages
        if (!data || !data.test || !Array.isArray(data.test) || data.test.length === 0) {
            console.log('ℹ️ No test numbers configured - processing all messages');
            return true;
        }

        // Test mode is enabled - normalize all test numbers
        const testNumbers = Array.isArray(data.test) ? data.test : [];
        const normalizedTestNumbers = testNumbers
            .map(num => normalizeNumber(num))
            .filter(Boolean); // Remove any empty strings

        console.log('🧪 Test mode ENABLED');
        console.log('📋 Test numbers:', normalizedTestNumbers);
        
        // Check if the user's number is in the test list
        const isTestUser = normalizedTestNumbers.includes(normalizedUserNumber);
        console.log(`${isTestUser ? '✅' : '❌'} User ${normalizedUserNumber} is ${isTestUser ? 'in test list' : 'not in test list'}`);
        console.log(`==========================\n`);
        
        return isTestUser;
    } catch (error) {
        console.error('Error in test mode check:', error);
        console.error('Stack:', error.stack);
        return true; // On error, process message by default
    }
}

// Modificar generateExternalLLMResponse para manejar blacklist y sess_id
async function generateExternalLLMResponse({ clientId, final_user, customer, sess_id, message }) {
    try {
        if (!process.env.LLM_API_URL) {
            console.error('\n=== ERROR DE CONFIGURACIÓN ==='.red);
            console.error('❌ LLM_API_URL no está definida en las variables de entorno');
            throw new Error('URL del API no configurada');
        }

        // Sanear los parámetros y nunca enviar sess_id=blacklist al LLM
        const params = new URLSearchParams({
            final_user: final_user.replace('@c.us', ''), // Remover @c.us del número
            customer: customer,                          // Número del bot
            sess_id: sess_id === 'blacklist' ? null : sess_id,
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

        // Guardar sess_id si viene en la respuesta (siempre, incluso si hay error)
        if (response.data && response.data.sess_id === 'blacklist') {
            console.log('\n=== BLACKLIST REQUEST DETECTED ==='.yellow);
            const normalizedNumber = final_user.replace('@c.us', '');
            const normalizedBot = customer;

            try {
                // Eliminar sesión del usuario
                userSessions.delete(final_user);
                console.log(`🗑️ Sesión eliminada para usuario ${normalizedNumber}`);

                // Actualizar blacklist en Supabase
                const { data: clientData, error: fetchError } = await supabase
                    .from('clients')
                    .select('blacklist')
                    .eq('final_user', normalizedBot)
                    .single();

                if (fetchError) throw fetchError;

                const currentBlacklist = Array.isArray(clientData?.blacklist) ? clientData.blacklist : [];
                if (!currentBlacklist.includes(normalizedNumber)) {
                    const newBlacklist = [...currentBlacklist, normalizedNumber];

                    const { error: updateError } = await supabase
                        .from('clients')
                        .update({ blacklist: newBlacklist })
                        .eq('final_user', normalizedBot);

                    if (updateError) throw updateError;
                    console.log(`✅ Added ${normalizedNumber} to blacklist of ${normalizedBot}`);
                }
            } catch (dbError) {
                console.error('Database operation failed:', dbError);
            }
        } else if (response.data && response.data.sess_id) {
            // Actualizar o crear sesión con timestamp
            const sess_server = `${clientId}_${final_user}_${response.data.sess_id}`;
            userSessions.set(final_user, {
                clientId,
                sess_id: response.data.sess_id,
                sess_server: sess_server,
                lastActivity: Date.now()
            });
            console.log(`📝 Sesión actualizada: ${sess_server}`);
        }

        // Verificar si el mensaje está vacío
        if (!response.data || !response.data.message || response.data.message.trim() === '') {
            console.warn('\n=== RESPUESTA VACÍA DETECTADA ==='.yellow);
            console.warn('⚠️ El LLM devolvió un mensaje vacío');
            console.warn('📊 Datos recibidos:', JSON.stringify(response.data, null, 2));
            console.warn('🔄 Enviando mensaje predeterminado');
            console.warn('==============================\n'.yellow);

            // Usar mensaje predeterminado cuando la respuesta esté vacía
            return "lo siento no he entendido,por favor explicate mejor.";
        }

        return response.data.message;
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
    console.log('\n=== NUEVA CONEXIÓN WEBSOCKET ===');
    console.log('ID:', socket.id);
    console.log('Origen:', socket.handshake.headers.origin);
    console.log('Transporte:', socket.conn.transport.name);
    console.log('================================\n');
    next();
});

// API para manejar WebSocket con mejor logging
io.on('connection', (socket) => {
    console.log('📡 FRONTEND conectado');

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
                // Enviar el QR más reciente al nuevo cliente
                socket.emit('qrCode', clientData.qr);
            }
            // Si no hay QR, el evento qr del cliente se activará y enviará uno nuevo
        } else {
            startWhatsAppClient(clientId, socket);
        }
    });

    socket.on('disconnect', () => {
        console.log('📡 FRONTEND desconectado');
    });
});

// Enhanced WebSocket error handling
io.engine.on("connection_error", (err) => {
    console.error('Connection error:', err);
});

// Agregar manejo específico de WebSocket
server.on('upgrade', (request, socket, head) => {
    console.log('WebSocket upgrade requested');
    socket.on('error', (err) => {
        console.error('WebSocket error:', err);
    });
});

// Manejo de señales para cierre limpio
process.on('SIGTERM', () => {
    console.log('Recibida señal SIGTERM - Cerrando servidor...');
    // Properly close all WhatsApp connections
    const closePromises = Array.from(clients.entries()).map(([clientId, clientData]) => {
        return new Promise((resolve) => {
            if (clientData.client) {
                console.log(`🔒 Cerrando cliente WhatsApp: ${clientId}`);
                clientData.client.destroy()
                    .then(() => resolve())
                    .catch(err => {
                        console.error(`Error cerrando cliente ${clientId}:`, err);
                        resolve();
                    });
            } else {
                resolve();
            }
        });
    });
    
    Promise.all(closePromises).then(() => {
        server.close(() => {
            console.log('Servidor cerrado correctamente');
            process.exit(0);
        });
    });
});

const args = process.argv.slice(2);
let PORT = process.env.PORT || 3001;

// Check for port argument (-p or --port)
const portIndex = args.findIndex(arg => arg === '-p' || '--port');
if (portIndex !== -1 && args[portIndex + 1]) {
    const portArg = parseInt(args[portIndex + 1]);
    if (!isNaN(portArg) && portArg > 0 && portArg < 65536) {
        PORT = portArg;
        console.log(`📌 Puerto configurado por línea de comandos: ${PORT}`);
    } else {
        console.error('❌ Puerto inválido, usando puerto por defecto:', PORT);
    }
}

// Iniciar el servidor HTTPS
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n=== SERVIDOR INICIADO ===');
    console.log(`🚀 Puerto: ${PORT}`);
    console.log(`🔒 SSL/TLS: Activo`);
    console.log(`💡 Uso: node serverAWSCliente0.js -p <puerto>`);
    console.log('========================\n');
});

// Agregar manejo de errores para el servidor HTTPS
server.on('error', (err) => {
    console.error('Error en el servidor HTTPS:', err);
    if (err.code === 'EACCES') {
        console.error(`Puerto ${PORT} requiere privilegios elevados`);
    } else if (err.code === 'EADDRINUSE') {
        console.error(`Puerto ${PORT} ya está en uso`);
    }
});
