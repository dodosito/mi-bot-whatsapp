const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin'); // Importa la librería de Firebase Admin SDK
const app = express();
app.use(express.json()); // Para que el bot entienda los mensajes que le llegan

// --- CONFIGURACIÓN DE FIREBASE/FIRESTORE ---
// Lee la clave secreta JSON de las variables de entorno de Railway
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

// Inicializa Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore(); // Obtiene una referencia a la base de datos Firestore

// --- RUTA PARA EL CHEQUEO DE SALUD DE RAILWAY ---
// Esta ruta es solo para Railway. Siempre responde 200 OK para que Railway sepa que el bot está vivo.
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// --- TUS SECRETOS (VARIABLES DE ENTORNO) ---
// El bot leerá estas claves de Railway (Variables de Entorno).
// NO debes cambiar estas líneas en el código.
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000; // Railway asigna 8080 internamente, pero 3000 es el respaldo.

// --- RUTA PARA LA VERIFICACIÓN DE META (Webhook GET) ---
// Meta (WhatsApp) usa esto para asegurarse de que tu bot está vivo y escuchando.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFICADO ✅');
      res.status(200).send(challenge); // DEBES DEVOLVER EL "challenge" DE META
    } else {
      // Si el token de verificación no coincide
      console.log('Error de verificación: Token no coincide.');
      res.sendStatus(403); // Forbidden
    }
  } else {
    // Si faltan parámetros en la solicitud de verificación (Esto es lo que Railway estaba recibiendo antes)
    console.log('Error de verificación: Faltan parámetros en la URL.');
    res.sendStatus(400); // Bad Request
  }
});

// --- RUTA PARA RECIBIR MENSAJES DE WHATSAPP (Webhook POST) ---
// Aquí es donde tu bot recibe los mensajes de texto que la gente le envía.
app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('📥 WEBHOOK RECIBIDO:', JSON.stringify(body, null, 2));

  // Aseguramos que es un mensaje de WhatsApp y que contiene un mensaje de texto
  if (body.object === 'whatsapp_business_account' &&
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]) {

    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; // Número de teléfono que envió el mensaje
    const messageId = message.id; // ID del mensaje para marcarlo como leído
    const messageType = message.type; // Tipo de mensaje (text, image, etc.)
    const timestamp = new Date(parseInt(message.timestamp) * 1000); // Convierte el timestamp a fecha legible

    // Marcar el mensaje como leído en WhatsApp (opcional, pero buena práctica)
    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId
            },
            {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                }
            }
        );
        console.log(`Mensaje ${messageId} marcado como leído.`);
    } catch (readError) {
        console.error('Error al marcar mensaje como leído:', readError.response ? JSON.stringify(readError.response.data, null, 2) : readError.message);
    }

    if (messageType === 'text') {
      const userMessage = message.text.body;
      console.log(`💬 Mensaje de ${from}: ${userMessage}`);

      let botResponse = 'Lo siento, no pude obtener una respuesta en este momento.'; // Default response

      try {
        // Paso 1: Enviar el mensaje del usuario a OpenRouter para obtener una respuesta del bot
        const openRouterResponse = await axios.post(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            model: 'moonshotai/kimi-k2:free', // Usando el modelo original que tenías
            messages: [{ role: 'user', content: userMessage }],
          },
          {
            headers: {
              'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 15000 // Aumenta el tiempo de espera por si OpenRouter tarda un poco
          }
        );

        botResponse = openRouterResponse.data.choices[0].message.content;
        console.log('🤖 Respuesta del bot:', botResponse);

        // Paso 2: Enviar la respuesta del bot de vuelta al usuario en WhatsApp
        await axios.post(
          `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, // Asegúrate de que la versión de la API sea correcta (v19.0)
          {
            messaging_product: 'whatsapp',
            to: from,
            type: 'text',
            text: { body: botResponse },
          },
          {
            headers: {
              'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );
        console.log('✅ Mensaje enviado a WhatsApp.');

      } catch (error) {
        console.error('❌ ERROR al procesar mensaje o enviar respuesta:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Si hay un error, el botResponse ya tiene el mensaje de error por defecto
      }

      // --- GUARDAR LA CONVERSACIÓN EN FIRESTORE ---
      try {
        await db.collection('conversations').add({
          phoneNumber: from,
          userMessage: userMessage,
          botResponse: botResponse, // Guarda la respuesta real o el mensaje de error si hubo uno
          timestamp: timestamp,
          messageId: messageId
        });
        console.log('💾 Conversación guardada en Firestore.');
      } catch (dbError) {
        console.error('❌ ERROR al guardar en Firestore:', dbError.message);
      }

    } else {
      console.log(`Mensaje no es de texto. Tipo: ${messageType}`);
      // Opcional: Notificar al usuario que solo se procesan mensajes de texto
      try {
          await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: 'whatsapp',
              to: from,
              type: 'text',
              text: { body: 'Lo siento, solo puedo responder a mensajes de texto por ahora.' },
            },
            {
              headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );
        } catch (sendError) {
          console.error('❌ ERROR al enviar mensaje de solo texto:', sendError.response ? JSON.stringify(sendError.response.data, null, 2) : sendError.message);
        }
    }
  } else {
    // Esto captura webhooks que no son de WhatsApp o no tienen el formato esperado
    console.log('El webhook recibido no contiene un mensaje de WhatsApp válido o no es de una cuenta de negocio.');
  }
  res.sendStatus(200); // MUY IMPORTANTE: Siempre responde 200 OK a WhatsApp para que no reintente el mismo mensaje.
});

// --- INSTRUCCIÓN FINAL PARA QUE EL BOT SE QUEDE ENCENDIDO ---
// Esto es lo que mantiene tu aplicación Express escuchando en el puerto
// y evita que Railway la apague.
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes! 🚀');
});
