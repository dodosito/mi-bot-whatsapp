const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json()); // Esto es para que el bot entienda los mensajes que le llegan

// --- TUS SECRETOS (VARIABLES DE ENTORNO) ---
// NO CAMBIES estas líneas, el bot las leerá de Railway
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 8080; // Usaremos 8080, como vimos en tus logs

// --- RUTA PARA LA VERIFICACIÓN DE META (WhatsApp) ---
// Esto es lo que Meta intenta contactar para saber si tu bot está vivo
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFICADO ✅');
      res.status(200).send(challenge);
    } else {
      // Si el token no coincide
      console.log('Error de verificación: Token no coincide');
      res.sendStatus(403);
    }
  } else {
    // Si faltan parámetros
    console.log('Error de verificación: Faltan parámetros');
    res.sendStatus(400);
  }
});

// --- RUTA PARA RECIBIR MENSAJES DE WHATSAPP ---
// Aquí es donde tu bot recibe los mensajes de la gente
app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('Mensaje recibido:', JSON.stringify(body, null, 2));

  // Verifica que el mensaje es de WhatsApp y es un mensaje de texto
  if (body.object === 'whatsapp_business_account') {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from; // Número del que envía
      const type = message.type; // Tipo de mensaje (texto, imagen, etc.)

      if (type === 'text') {
        const userMessage = message.text.body;
        console.log(`Mensaje de ${from}: ${userMessage}`);

        try {
          // Llama a OpenRouter para obtener una respuesta
          const openRouterResponse = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'mistralai/mistral-7b-instruct', // Puedes cambiar el modelo si quieres
              messages: [{ role: 'user', content: userMessage }],
            },
            {
              headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
              },
            }
          );

          const botResponse = openRouterResponse.data.choices[0].message.content;
          console.log(`Respuesta del bot: ${botResponse}`);

          // Envía la respuesta de vuelta a WhatsApp
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
          console.log('Mensaje enviado a WhatsApp');

        } catch (error) {
          console.error('Error al procesar el mensaje o enviar respuesta:', error.response ? error.response.data : error.message);
          // Opcional: Envía un mensaje de error al usuario de WhatsApp
          await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: 'whatsapp',
              to: from,
              type: 'text',
              text: { body: 'Lo siento, hubo un error al procesar tu mensaje. Intenta de nuevo más tarde.' },
            },
            {
              headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );
        }
      } else {
        console.log(`Mensaje no es de texto o no es válido: ${type}`);
        // Opcional: Puedes enviar un mensaje diciendo que solo procesas texto
         await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            {
              messaging_product: 'whatsapp',
              to: from,
              type: 'text',
              text: { body: 'Solo puedo responder a mensajes de texto por ahora.' },
            },
            {
              headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );
      }
    } else {
      console.log('No hay mensajes válidos en la entrada.');
    }
  }
  res.sendStatus(200); // Siempre responde 200 OK a WhatsApp para que no reintente
});

// --- INSTRUCCIÓN FINAL PARA QUE EL BOT SE QUEDE ENCENDIDO ---
// ESTO ES LO MÁS IMPORTANTE PARA QUE RAILWAY NO LO APAGUE
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes!');
});

// --- INSTRUCCIÓN FINAL PARA QUE EL BOT SE QUEDE ENCENDIDO ---
// ESTO ES LO MÁS IMPORTANTE PARA QUE RAILWAY NO LO APAGUE
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log('¡El bot está vivo y esperando mensajes!');
});

// --- CÓDIGO EXTRA PARA AYUDAR AL BOT A PERMANECER ACTIVO EN RAILWAY ---
// Esto es para que el bot responda correctamente cuando Railway intente apagarlo
// y se asegure de no terminar por sí solo inesperadamente.
process.on('SIGINT', () => {
  console.log('Señal SIGINT recibida. Cerrando servidor...');
  process.exit(0); // Cierra el proceso de forma limpia
});

process.on('SIGTERM', () => {
  console.log('Señal SIGTERM recibida. Cerrando servidor...');
  process.exit(0); // Cierra el proceso de forma limpia
});
