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

// --- FUNCIONES PARA GESTIONAR EL ESTADO DEL USUARIO EN FIRESTORE ---
/**
 * Obtiene el estado actual de un usuario desde Firestore.
 * Si el usuario no tiene un estado registrado, devuelve un estado 'IDLE' por defecto.
 * @param {string} phoneNumber - El número de teléfono del usuario.
 * @returns {Promise<object>} El objeto de estado del usuario.
 */
async function getUserState(phoneNumber) {
    const userStateRef = db.collection('user_states').doc(phoneNumber);
    const doc = await userStateRef.get();
    if (doc.exists) {
        return doc.data();
    } else {
        // Estado por defecto si no hay registro
        return { status: 'IDLE', data: {} };
    }
}

/**
 * Establece o actualiza el estado de un usuario en Firestore.
 * @param {string} phoneNumber - El número de teléfono del usuario.
 * @param {string} status - El nuevo estado del usuario (ej. 'IDLE', 'AWAITING_PRODUCT').
 * @param {object} data - Datos adicionales para guardar con el estado (ej. producto, cantidad).
 */
async function setUserState(phoneNumber, status, data = {}) {
    const userStateRef = db.collection('user_states').doc(phoneNumber);
    await userStateRef.set({ status, data, lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
}

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
      const userMessage = message.text.body.toLowerCase().trim(); // Convertir a minúsculas y quitar espacios
      console.log(`💬 Mensaje de ${from}: ${userMessage}`);

      let botResponse = 'Lo siento, no pude obtener una respuesta en este momento.'; // Respuesta por defecto
      let currentUserState = await getUserState(from); // Obtener el estado actual del usuario
      let currentStatus = currentUserState.status;
      let currentData = currentUserState.data || {}; // Datos asociados al estado actual

      try {
        // --- MANEJO GLOBAL DE CANCELACIÓN ---
        // Si el usuario dice "cancelar" en cualquier momento, se resetea el flujo
        if (userMessage.includes('cancelar')) {
            botResponse = 'Operación cancelada. ¿Hay algo más en lo que pueda ayudarte?';
            await setUserState(from, 'IDLE', {}); // Volver a IDLE
        } else {
            // --- LÓGICA DE FLUJOS DE CONVERSACIÓN ---
            switch (currentStatus) {
                case 'IDLE':
                    // Reconocimiento más flexible para iniciar pedido
                    if (userMessage.includes('pedir') || userMessage.includes('comprar') || userMessage.includes('ordenar')) {
                        botResponse = '¡Claro! ¿Qué producto te gustaría pedir?';
                        await setUserState(from, 'AWAITING_PRODUCT', {}); // Establecer nuevo estado y resetear datos
                    } else {
                        // Comportamiento por defecto: enviar a OpenRouter si no está en un flujo
                        const openRouterResponse = await axios.post(
                            'https://openrouter.ai/api/v1/chat/completions',
                            {
                                model: 'moonshotai/kimi-k2:free',
                                messages: [{ role: 'user', content: userMessage }],
                            },
                            {
                                headers: {
                                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                                    'Content-Type': 'application/json',
                                },
                                timeout: 15000
                            }
                        );
                        botResponse = openRouterResponse.data.choices[0].message.content;
                    }
                    break;

                case 'AWAITING_PRODUCT':
                    currentData.product = userMessage; // Guardar el producto (el mensaje completo del usuario)
                    botResponse = `¿Cuántas unidades de "${currentData.product}" necesitas?`;
                    await setUserState(from, 'AWAITING_QUANTITY', currentData); // Avanzar al siguiente estado
                    break;

                case 'AWAITING_QUANTITY':
                    const quantity = parseInt(userMessage); // Intentar convertir el mensaje a número
                    if (!isNaN(quantity) && quantity > 0) { // Validar que sea un número positivo
                        currentData.quantity = quantity; // Guardar la cantidad
                        botResponse = `¿Confirmas tu pedido de ${currentData.quantity} unidades de "${currentData.product}"? (Sí/No)`;
                        await setUserState(from, 'AWAITING_CONFIRMATION', currentData); // Avanzar al siguiente estado
                    } else {
                        botResponse = 'Por favor, ingresa una cantidad válida (un número positivo).';
                        // Mantenerse en el mismo estado si la entrada es inválida
                    }
                    break;

                case 'AWAITING_CONFIRMATION':
                    if (userMessage === 'sí' || userMessage === 'si') {
                        botResponse = `¡Pedido de ${currentData.quantity} unidades de "${currentData.product}" confirmado! Te avisaremos cuando esté listo.`;
                        // --- AQUÍ SE INTEGRARÍA CON SAP EN EL FUTURO ---
                        console.log('🎉 Pedido finalizado y confirmado:', currentData);
                        await setUserState(from, 'IDLE', {}); // Resetear estado después de completar el pedido

                        // Opcional: Guardar el pedido final en una colección separada 'orders'
                        await db.collection('orders').add({
                            phoneNumber: from,
                            product: currentData.product,
                            quantity: currentData.quantity,
                            status: 'CONFIRMED',
                            orderDate: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log('💾 Pedido guardado en la colección "orders".');

                    } else if (userMessage === 'no') {
                        botResponse = 'Pedido cancelado. ¿Hay algo más en lo que pueda ayudarte?';
                        await setUserState(from, 'IDLE', {}); // Volver a IDLE
                    } else {
                        botResponse = 'Por favor, responde "Sí" para confirmar o "No" para cancelar el pedido.';
                        // Mantenerse en el mismo estado si la entrada es inválida
                    }
                    break;

                default:
                    // Si el estado es desconocido o inválido, se resetea a IDLE
                    botResponse = 'Lo siento, hubo un error en el flujo de conversación. Por favor, di "cancelar" para empezar de nuevo.';
                    await setUserState(from, 'IDLE', {});
                    break;
            }
        } // Fin del else del manejo global de cancelación

        // Enviar la respuesta determinada por el bot a WhatsApp
        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
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
        // Si hay un error en la lógica del flujo o al enviar, enviar un error genérico al usuario
        try {
            await axios.post(
                `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: from,
                    type: 'text',
                    text: { body: 'Lo siento, hubo un error inesperado. Por favor, intenta de nuevo.' },
                },
                {
                    headers: {
                        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                        'Content-Type': 'application/json',
                    },
                }
            );
        } catch (sendError) {
            console.error('❌ ERROR al enviar mensaje de error al usuario:', sendError.response ? JSON.stringify(sendError.response.data, null, 2) : sendError.message);
        }
        // Resetear estado a IDLE en caso de error crítico
        await setUserState(from, 'IDLE', {});
      }

      // --- GUARDAR LA CONVERSACIÓN EN FIRESTORE (lógica existente) ---
      // Esta parte sigue capturando tanto la entrada del usuario como la respuesta final del bot
      try {
        await db.collection('conversations').add({
          phoneNumber: from,
          userMessage: userMessage, // Mensaje real del usuario
          botResponse: botResponse, // Respuesta real del bot (del flujo o de la IA)
          timestamp: timestamp,
          messageId: messageId
        });
        console.log('💾 Conversación guardada en Firestore.');
      } catch (dbError) {
        console.error('❌ ERROR al guardar en Firestore:', dbError.message);
      }

    } else {
      console.log(`Mensaje no es de texto. Tipo: ${messageType}`);
      // Si el mensaje no es de texto, el bot informa al usuario
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
