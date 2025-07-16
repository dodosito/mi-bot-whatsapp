const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// --- RUTA PARA EL CHEQUEO DE SALUD DE RAILWAY ---
// Esta ruta siempre responde 200 OK para que Railway sepa que el bot está vivo.
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// --- TUS SECRETOS (VARIABLES DE ENTORNO) ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000; // Puerto correcto para Railway

// --- RUTA PARA LA VERIFICACIÓN DE META (Webhook GET) ---
app.get('/webhook', (req, res) => {
  // ... (el resto de tu código de webhook GET)
});

// --- RUTA PARA RECIBIR MENSAJES DE WHATSAPP (Webhook POST) ---
app.post('/webhook', async (req, res) => {
  // ... (el resto de tu código de webhook POST)
});

// --- INSTRUCCIÓN FINAL PARA QUE EL BOT SE QUEDE ENCENDIDO ---
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes! 🚀');
});
