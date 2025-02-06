const makeWASocket = require("@whiskeysockets/baileys").default;
const { DisconnectReason, useMultiFileAuthState } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qr-image");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const path = require("path");
const fs = require('fs').promises;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "https://asistentewhats.netlify.app",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Variables de estado
let sock = null;
let lastQr = null;

// Crear directorio temporal para auth si no existe
const AUTH_DIR = path.join('/tmp', 'whatsapp_auth');

// Función para iniciar el cliente WhatsApp
const startWhatsAppClient = async () => {
    if (sock) return;  // Evita múltiples instancias
    
    try {
        // Asegurar que el directorio temporal existe
        await fs.mkdir(AUTH_DIR, { recursive: true });
        
        // Configurar el estado de autenticación en directorio temporal
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        
        sock = makeWASocket({
            printQRInTerminal: false,
            browser: ["Chrome", "Safari", "1.0"],
            auth: state
        });

        // Evento para guardar credenciales
        sock.ev.on("creds.update", saveCreds);

        // Evento para generar el código QR
        sock.ev.on("connection.update", (update) => {
            const { qr, connection, lastDisconnect } = update;
            
            if (qr) {
                console.log("📡 Generando QR...");
                lastQr = `data:image/png;base64,${qrcode.imageSync(qr, { type: "png" }).toString("base64")}`;
                io.emit("qrCode", lastQr);
            }

            if (connection === "close") {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                console.log("❌ Conexión cerrada debido a:", lastDisconnect?.error?.output?.payload?.message);
                
                if (shouldReconnect) {
                    sock = null;
                    setTimeout(startWhatsAppClient, 5000);
                }
            } else if (connection === "open") {
                console.log("✅ WhatsApp conectado!");
                io.emit("botReady", true);
            }
        });

        // Evento para recibir mensajes
        sock.ev.on("messages.upsert", async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;
            
            const userMessage = msg.message.conversation || msg.message?.extendedTextMessage?.text || "";
            const userId = msg.key.remoteJid;
            
            if (userMessage.toLowerCase() === "hola") {
                await sock.sendMessage(userId, { text: "👋 ¡Hola! Soy el asistente de WhatsApp." });
                return;
            }

            const response = await generateExternalLLMResponse(userId, userMessage);
            await sock.sendMessage(userId, { text: response });
        });

    } catch (error) {
        console.error("Error al iniciar el cliente de WhatsApp:", error);
        // Reintentar en caso de error
        setTimeout(startWhatsAppClient, 5000);
    }
};

// Función para llamar al LLM
async function generateExternalLLMResponse(userId, message) {
    try {
        const response = await axios.post(process.env.LLM_API_URL, { message });
        return response.data.outputCustomer.message || "Error al generar respuesta.";
    } catch (error) {
        console.error("❌ Error con LLM API:", error.message);
        return "Lo siento, hubo un error generando la respuesta.";
    }
}

// WebSockets para QR
io.on("connection", (socket) => {
    console.log("📡 Cliente conectado");
    socket.on("startQR", () => {
        if (!sock) startWhatsAppClient();
    });
    if (lastQr) {
        socket.emit("qrCode", lastQr);
    }
});

// Limpiar directorio temporal al iniciar
process.on('SIGTERM', async () => {
    try {
        await fs.rm(AUTH_DIR, { recursive: true, force: true });
    } catch (error) {
        console.error('Error al limpiar directorio temporal:', error);
    }
    process.exit(0);
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server en ejecución en http://localhost:${PORT}`);
    startWhatsAppClient().catch(console.error);
});
