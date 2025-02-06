const makeWASocket = require("@whiskeysockets/baileys").default;
const { DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qr-image");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios"); // Added missing axios import

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

// Función para iniciar el cliente WhatsApp
const startWhatsAppClient = () => {
    if (sock) return;  // Evita múltiples instancias
    
    sock = makeWASocket({
        printQRInTerminal: false,  // No imprime QR en consola
        browser: ["Chrome", "Safari", "1.0"], // Simula WhatsApp Web
        auth: undefined  // No almacena credenciales
    });

    // Evento para generar el código QR
    sock.ev.on("connection.update", (update) => {
        const { qr, connection, lastDisconnect } = update;
        
        if (qr) {
            console.log("📡 Generando QR...");
            lastQr = `data:image/png;base64,${qrcode.imageSync(qr, { type: "png" }).toString("base64")}`;
            io.emit("qrCode", lastQr);
        }

        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log("❌ Conexión cerrada, motivo:", reason);
            sock = null;
            setTimeout(startWhatsAppClient, 5000); // Reintentar tras 5 segundos
        } else if (connection === "open") {
            console.log("✅ WhatsApp conectado!");
            io.emit("botReady", true);
        }
    });

    // Evento para recibir mensajes
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const userMessage = msg.message.conversation || msg.message?.extendedTextMessage?.text || ""; // Added support for quoted messages
        const userId = msg.key.remoteJid;
        
        if (userMessage.toLowerCase() === "hola") {
            await sock.sendMessage(userId, { text: "👋 ¡Hola! Soy el asistente de WhatsApp." });
            return;
        }

        const response = await generateExternalLLMResponse(userId, userMessage);
        await sock.sendMessage(userId, { text: response });
    });
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

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server en ejecución en http://localhost:${PORT}`);
    startWhatsAppClient();
});
