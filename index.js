const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
app.use(express.json());

// --- CONFIGURACIÓN DE FIREBASE/FIRESTORE ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- DATOS SIMULADOS DE SAP (Como si vinieran de tus "Excel") ---
// Estos datos simulan lo que obtendríamos de las APIs de SAP.
// En un futuro, estas listas se reemplazarían por llamadas a APIs reales de SAP.

const simulatedSapConfig = {
    SalesOrderType: "OR", // Tipo de pedido estándar
    DistributionChannel: "10",
    Division: "00",
    Plant: "1000", // Centro por defecto
    RequestedQuantityUnitDefault: "EA", // Unidad por defecto
    RequestedDeliveryDaysFromNow: 3 // Entrega en 3 días hábiles
};

const simulatedCustomers = [
    { phoneNumber: "51991690070", sapCustomerId: "1000001", SalesOrganization: "1000", name: "Rommel Cliente A" },
    { phoneNumber: "51991234567", sapCustomerId: "1000002", SalesOrganization: "2000", name: "Cliente B" },
    // Puedes añadir más clientes aquí
];

const simulatedMaterials = [
    { friendlyName: "platanos", materialCode: "MAT001", unit: "KG", description: "Plátanos Cavendish" },
    { friendlyName: "manzanas", materialCode: "MAT002", unit: "EA", description: "Manzanas Rojas" },
    { friendlyName: "arroz", materialCode: "MAT003", unit: "KG", description: "Arroz Grano Largo" },
    { friendlyName: "leche", materialCode: "MAT004", unit: "LT", description: "Leche Entera 1L" },
    // Añade más materiales según tus necesidades
];

// --- SIMULACIONES DE LLAMADAS A APIS DE SAP ---
// Estas funciones actúan como si se conectaran a SAP.

/**
 * Simula la obtención de detalles del cliente desde SAP.
 * @param {string} phoneNumber - Número de teléfono del cliente.
 * @returns {Promise<object|null>} Detalles del cliente SAP o null si no se encuentra.
 */
async function simulateGetCustomerDetails(phoneNumber) {
    // Busca el cliente en nuestra lista simulada
    const customer = simulatedCustomers.find(c => c.phoneNumber === phoneNumber);
    if (customer) {
        // Simula la obtención de datos adicionales de SAP para ese cliente
        return {
            SoldToParty: customer.sapCustomerId,
            SalesOrganization: customer.SalesOrganization,
            name: customer.name,
            // Otros datos de cabecera específicos del cliente
        };
    }
    return null;
}

/**
 * Simula la búsqueda de un material en SAP.
 * @param {string} description - Descripción del material ingresada por el cliente.
 * @param {boolean} [aiAssisted=false] - Si la búsqueda debe ser asistida por IA.
 * @returns {Promise<object|null>} Material encontrado o null.
 */
async function simulateSearchMaterial(description, aiAssisted = false) {
    const lowerCaseDescription = description.toLowerCase();

    // 1. Intento de búsqueda directa por nombre amigable exacto
    let foundMaterial = simulatedMaterials.find(m => m.friendlyName === lowerCaseDescription);
    if (foundMaterial) {
        return foundMaterial;
    }

    // 2. Intento de búsqueda por inclusión (si el cliente dice "quiero plátanos" y solo tenemos "platanos")
    foundMaterial = simulatedMaterials.find(m => lowerCaseDescription.includes(m.friendlyName));
    if (foundMaterial) {
        return foundMaterial;
    }

    // 3. Si no se encuentra y se solicita asistencia de IA
    if (aiAssisted && OPENROUTER_API_KEY) {
        console.log('🧠 Intentando asistencia de IA para encontrar material...');
        const materialNames = simulatedMaterials.map(m => m.friendlyName).join(', ');
        const prompt = `El usuario busca un producto. Dada la descripción "${description}", ¿cuál de los siguientes productos se parece más o es el mismo? Responde solo con el nombre del producto de la lista, o "NINGUNO" si no hay coincidencia clara. Lista de productos: ${materialNames}.`;

        try {
            const openRouterResponse = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                    model: 'moonshotai/kimi-k2:free',
                    messages: [{ role: 'user', content: prompt }],
                },
                {
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 10000 // Tiempo de espera para la IA
                }
            );
            const aiSuggestion = openRouterResponse.data.choices[0].message.content.toLowerCase().trim();
            console.log('🧠 Sugerencia de IA:', aiSuggestion);

            if (aiSuggestion !== 'ninguno') {
                foundMaterial = simulatedMaterials.find(m => m.friendlyName === aiSuggestion);
                if (foundMaterial) {
                    return foundMaterial;
                }
            }
        } catch (aiError) {
            console.error('❌ Error en asistencia de IA para material:', aiError.response ? aiError.response.data : aiError.message);
        }
    }
    return null; // No se encontró el material
}

/**
 * Simula la creación de un pedido de venta en SAP.
 * @param {object} orderData - Datos completos del pedido (cabecera y posiciones).
 * @returns {Promise<object>} Objeto con el número de pedido simulado y estado.
 */
async function simulateCreateSalesOrder(orderData) {
    console.log('--- SIMULANDO ENVÍO DE PEDIDO A SAP ---');
    console.log('Datos del Pedido a SAP:', JSON.stringify(orderData, null, 2));
    // En un entorno real, aquí iría la llamada a la API de SAP
    // const sapResponse = await axios.post('URL_API_SAP/SalesOrder', orderData, { headers: ... });
    console.log('--- FIN SIMULACIÓN ---');
    return { salesOrderNumber: `SAP_ORD_${Date.now()}`, status: 'CREATED' };
}


// --- FUNCIONES PARA GESTIONAR EL ESTADO DEL USUARIO EN FIRESTORE ---
async function getUserState(phoneNumber) {
    const userStateRef = db.collection('user_states').doc(phoneNumber);
    const doc = await userStateRef.get();
    if (doc.exists) {
        return doc.data();
    } else {
        return { status: 'IDLE', data: {} };
    }
}

async function setUserState(phoneNumber, status, data = {}) {
    const userStateRef = db.collection('user_states').doc(phoneNumber);
    await userStateRef.set({ status, data, lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
}

// --- RUTA PARA EL CHEQUEO DE SALUD DE RAILWAY ---
app.get('/health', (req, res) => {
  res.sendStatus(200);
});

// --- TUS SECRETOS (VARIABLES DE ENTORNO) ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;

// --- RUTA PARA LA VERIFICACIÓN DE META (Webhook GET) ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFICADO ✅');
      res.status(200).send(challenge);
    } else {
      console.log('Error de verificación: Token no coincide.');
      res.sendStatus(403);
    }
  } else {
    console.log('Error de verificación: Faltan parámetros en la URL.');
    res.sendStatus(400);
  }
});

// --- FUNCIÓN PARA ENVIAR MENSAJES DE WHATSAPP (Centralizada) ---
async function sendWhatsAppMessage(to, messageBody, messageType = 'text', interactiveMessage = null) {
    try {
        const payload = {
            messaging_product: 'whatsapp',
            to: to,
        };

        if (messageType === 'text') {
            payload.type = 'text';
            payload.text = { body: messageBody };
        } else if (messageType === 'interactive' && interactiveMessage) {
            payload.type = 'interactive';
            payload.interactive = interactiveMessage;
        }
        // Puedes añadir más tipos de mensajes aquí (image, document, etc.)

        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log('✅ Mensaje enviado a WhatsApp.');
    } catch (error) {
        console.error('❌ ERROR al enviar mensaje a WhatsApp:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Si el token expira, el error se manejará aquí
    }
}


// --- RUTA PARA RECIBIR MENSAJES DE WHATSAPP (Webhook POST) ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log('📥 WEBHOOK RECIBIDO:', JSON.stringify(body, null, 2));

  if (body.object === 'whatsapp_business_account' &&
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]) {
    
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from;
    const messageId = message.id;
    const messageType = message.type;
    const timestamp = new Date(parseInt(message.timestamp) * 1000);

    // Marcar el mensaje como leído en WhatsApp
    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
            { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
            { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
            );
        console.log(`Mensaje ${messageId} marcado como leído.`);
    } catch (readError) {
        console.error('Error al marcar mensaje como leído:', readError.response ? JSON.stringify(readError.response.data, null, 2) : readError.message);
    }

    let userMessage = '';
    if (messageType === 'text') {
        userMessage = message.text.body.toLowerCase().trim();
    } else if (messageType === 'interactive' && message.interactive) {
        // Manejo de respuestas de botones o listas
        if (message.interactive.type === 'button_reply') {
            userMessage = message.interactive.button_reply.id; // El ID del botón
        } else if (message.interactive.type === 'list_reply') {
            userMessage = message.interactive.list_reply.id; // El ID del ítem de la lista
        }
        console.log(`💬 Mensaje interactivo de ${from}: ${userMessage}`);
    } else {
        // Si no es texto ni interactivo, informamos al usuario y salimos
        await sendWhatsAppMessage(from, 'Lo siento, por ahora solo puedo procesar mensajes de texto y selecciones de menú.');
        res.sendStatus(200);
        return;
    }

    console.log(`💬 Mensaje de ${from}: ${userMessage}`);

    let botResponse = 'Lo siento, no pude obtener una respuesta en este momento.';
    let currentUserState = await getUserState(from);
    let currentStatus = currentUserState.status;
    let currentData = currentUserState.data || {};

    try {
        // --- MANEJO GLOBAL DE CANCELACIÓN ---
        if (userMessage.includes('cancelar')) {
            botResponse = 'Operación cancelada. ¿Hay algo más en lo que pueda ayudarte?';
            await setUserState(from, 'IDLE', {});
            await sendWhatsAppMessage(from, botResponse);
            res.sendStatus(200); // Responder 200 OK y salir
            return;
        }

        // --- LÓGICA DE FLUJOS DE CONVERSACIÓN ---
        switch (currentStatus) {
            case 'IDLE':
                // Intentar identificar al cliente SAP
                const customerDetails = await simulateGetCustomerDetails(from);
                if (!customerDetails) {
                    botResponse = 'Hola, no te encuentro registrado en nuestro sistema de clientes. Para realizar un pedido, por favor contacta a nuestro equipo de ventas o regístrate en nuestro portal.';
                    await sendWhatsAppMessage(from, botResponse);
                    res.sendStatus(200);
                    return;
                }
                currentData.customer = customerDetails; // Guardar datos del cliente en el estado

                // Presentar el menú principal con botones
                const mainMenu = {
                    type: "button",
                    header: { type: "text", text: "¡Hola! ¿Cómo puedo ayudarte hoy?" },
                    body: { type: "text", text: "Selecciona una opción:" },
                    action: {
                        buttons: [
                            { type: "reply", title: "🛒 Realizar Pedido", id: "MENU_REALIZAR_PEDIDO" },
                            { type: "reply", title: "💳 Consultar Crédito", id: "MENU_CONSULTAR_CREDITO" },
                            { type: "reply", title: "📦 Estado de Pedido", id: "MENU_ESTADO_PEDIDO" }
                        ]
                    }
                };
                await sendWhatsAppMessage(from, '', 'interactive', mainMenu);
                await setUserState(from, 'MAIN_MENU', currentData); // Esperando selección del menú
                break;

            case 'MAIN_MENU':
                if (userMessage === 'MENU_REALIZAR_PEDIDO') {
                    botResponse = '¡Excelente! ¿Qué producto te gustaría añadir a tu pedido?';
                    currentData.currentOrder = { items: [], header: {} }; // Inicializar el pedido
                    // Copiar datos de cabecera por defecto y específicos del cliente
                    currentData.currentOrder.header = {
                        ...simulatedSapConfig, // Datos de configuración general
                        SoldToParty: currentData.customer.SoldToParty,
                        SalesOrganization: currentData.customer.SalesOrganization,
                        // RequestedDeliveryDate se calculará al final
                        SalesOrderDate: new Date().toISOString().split('T')[0] // Fecha actual
                    };
                    await setUserState(from, 'AWAITING_PRODUCT', currentData);
                    await sendWhatsAppMessage(from, botResponse);
                } else if (userMessage === 'MENU_CONSULTAR_CREDITO') {
                    botResponse = `Tu línea de crédito disponible es: $15,000 USD. (Simulado para ${currentData.customer.name})`;
                    await setUserState(from, 'IDLE', {}); // Volver a IDLE después de la consulta
                    await sendWhatsAppMessage(from, botResponse);
                } else if (userMessage === 'MENU_ESTADO_PEDIDO') {
                    botResponse = `Para consultar el estado de tu pedido, por favor, dime el número de pedido. (Simulado)`;
                    await setUserState(from, 'AWAITING_ORDER_STATUS_ID', currentData);
                    await sendWhatsAppMessage(from, botResponse);
                } else {
                    // Si el usuario escribe algo en el menú, la IA responde
                    const openRouterResponse = await axios.post(
                        'https://openrouter.ai/api/v1/chat/completions',
                        { model: 'moonshotai/kimi-k2:free', messages: [{ role: 'user', content: userMessage }] },
                        { headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
                    );
                    botResponse = openRouterResponse.data.choices[0].message.content;
                    await sendWhatsAppMessage(from, botResponse);
                    // Mantenerse en MAIN_MENU si no se selecciona una opción válida
                }
                break;

            case 'AWAITING_PRODUCT':
                const foundMaterial = await simulateSearchMaterial(userMessage, true); // Búsqueda asistida por IA
                if (foundMaterial) {
                    currentData.currentItem = { // Guardar el item que se está procesando
                        Material: foundMaterial.materialCode,
                        RequestedQuantityUnit: foundMaterial.unit,
                        description: foundMaterial.description // Para el resumen
                    };
                    botResponse = `¿Cuántas unidades de "${foundMaterial.description}" necesitas?`;
                    await setUserState(from, 'AWAITING_QUANTITY', currentData);
                    await sendWhatsAppMessage(from, botResponse);
                } else {
                    botResponse = `Lo siento, no pude encontrar "${userMessage}" en nuestro catálogo. Por favor, intenta con otro nombre o escribe "cancelar" para volver al menú principal.`;
                    // Mantenerse en AWAITING_PRODUCT
                    await sendWhatsAppMessage(from, botResponse);
                }
                break;

            case 'AWAITING_QUANTITY':
                const quantity = parseInt(userMessage);
                if (!isNaN(quantity) && quantity > 0) {
                    currentData.currentItem.RequestedQuantity = quantity; // Guardar la cantidad
                    currentData.currentOrder.items.push(currentData.currentItem); // Añadir al pedido
                    delete currentData.currentItem; // Limpiar el item actual

                    const orderSummary = currentData.currentOrder.items.map(item => `- ${item.RequestedQuantity} ${item.RequestedQuantityUnit} de "${item.description}"`).join('\n');
                    const orderMenu = {
                        type: "button",
                        body: { type: "text", text: `Tu pedido actual:\n${orderSummary}\n\n¿Qué deseas hacer ahora?` },
                        action: {
                            buttons: [
                                { type: "reply", title: "➕ Añadir otro producto", id: "ORDER_ADD_MORE" },
                                { type: "reply", title: "✅ Finalizar pedido", id: "ORDER_FINISH" },
                                { type: "reply", title: "❌ Cancelar pedido", id: "ORDER_CANCEL" }
                            ]
                        }
                    };
                    await sendWhatsAppMessage(from, '', 'interactive', orderMenu);
                    await setUserState(from, 'AWAITING_ORDER_ACTION', currentData);
                } else {
                    botResponse = 'Por favor, ingresa una cantidad válida (un número positivo).';
                    await sendWhatsAppMessage(from, botResponse);
                    // Mantenerse en el mismo estado si la entrada es inválida
                }
                break;

            case 'AWAITING_ORDER_ACTION':
                if (userMessage === 'ORDER_ADD_MORE') {
                    botResponse = 'Perfecto, ¿qué otro producto te gustaría añadir?';
                    await setUserState(from, 'AWAITING_PRODUCT', currentData); // Volver a pedir producto
                    await sendWhatsAppMessage(from, botResponse);
                } else if (userMessage === 'ORDER_FINISH') {
                    const finalOrderSummary = currentData.currentOrder.items.map(item => `- ${item.RequestedQuantity} ${item.RequestedQuantityUnit} de "${item.description}"`).join('\n');
                    botResponse = `Tu pedido final es:\n${finalOrderSummary}\n\n¿Confirmas este pedido para procesarlo en SAP? (Sí/No)`;
                    await setUserState(from, 'AWAITING_FINAL_CONFIRMATION', currentData);
                    await sendWhatsAppMessage(from, botResponse);
                } else if (userMessage === 'ORDER_CANCEL') { // Aunque ya hay un manejo global, esto es explícito
                    botResponse = 'Pedido cancelado. ¿Hay algo más en lo que pueda ayudarte?';
                    await setUserState(from, 'IDLE', {});
                    await sendWhatsAppMessage(from, botResponse);
                } else {
                    botResponse = 'Por favor, selecciona una opción válida del menú (Añadir, Finalizar, Cancelar).';
                    // Mantenerse en AWAITING_ORDER_ACTION
                    await sendWhatsAppMessage(from, botResponse);
                }
                break;

            case 'AWAITING_FINAL_CONFIRMATION':
                if (userMessage === 'sí' || userMessage === 'si') {
                    // Calcular RequestedDeliveryDate
                    const deliveryDate = new Date();
                    deliveryDate.setDate(deliveryDate.getDate() + simulatedSapConfig.RequestedDeliveryDaysFromNow);
                    currentData.currentOrder.header.RequestedDeliveryDate = deliveryDate.toISOString().split('T')[0];

                    // Simular el envío a SAP
                    const sapResponse = await simulateCreateSalesOrder({
                        header: currentData.currentOrder.header,
                        items: currentData.currentOrder.items.map(item => ({
                            Material: item.Material,
                            RequestedQuantity: item.RequestedQuantity,
                            RequestedQuantityUnit: item.RequestedQuantityUnit,
                            Plant: simulatedSapConfig.Plant // Usar el centro por defecto
                        }))
                    });

                    // --- CAMBIO CLAVE AQUÍ: MOSTRAR EL NÚMERO DE PEDIDO SAP ---
                    botResponse = `¡Pedido #${sapResponse.salesOrderNumber} confirmado y enviado a SAP! Puedes usar este número para el seguimiento. Te avisaremos cuando esté procesado.`;
                    // --- FIN CAMBIO CLAVE ---

                    await setUserState(from, 'IDLE', {}); // Resetear estado
                    await sendWhatsAppMessage(from, botResponse);

                    // Guardar el pedido final en la colección 'orders' de Firestore
                    await db.collection('orders').add({
                        phoneNumber: from,
                        sapOrderNumber: sapResponse.salesOrderNumber,
                        orderData: currentData.currentOrder,
                        status: sapResponse.status,
                        orderDate: admin.firestore.FieldValue.serverTimestamp()
                    });
                    console.log('💾 Pedido guardado en la colección "orders".');

                } else if (userMessage === 'no') {
                    botResponse = 'Pedido cancelado. ¿Hay algo más en lo que pueda ayudarte?';
                    await setUserState(from, 'IDLE', {});
                    await sendWhatsAppMessage(from, botResponse);
                } else {
                    botResponse = 'Por favor, responde "Sí" para confirmar o "No" para cancelar el pedido.';
                    await sendWhatsAppMessage(from, botResponse);
                    // Mantenerse en el mismo estado
                }
                break;
            
            case 'AWAITING_ORDER_STATUS_ID':
                // Lógica para consultar estado de pedido por ID
                // Por ahora, solo simula
                botResponse = `Consultando estado para el pedido ${userMessage}... (Simulado) Tu pedido está en preparación.`;
                await setUserState(from, 'IDLE', {});
                await sendWhatsAppMessage(from, botResponse);
                break;


            default:
                // Si el estado es desconocido o inválido, se resetea a IDLE
                botResponse = 'Lo siento, hubo un error en el flujo de conversación. Por favor, di "cancelar" para empezar de nuevo.';
                await setUserState(from, 'IDLE', {});
                await sendWhatsAppMessage(from, botResponse);
                break;
        }

      } catch (error) {
        console.error('❌ ERROR en la lógica del flujo:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        await sendWhatsAppMessage(from, 'Lo siento, hubo un error inesperado en el bot. Por favor, intenta de nuevo.');
        await setUserState(from, 'IDLE', {}); // Resetear estado a IDLE en caso de error crítico
      }

      // --- GUARDAR LA CONVERSACIÓN EN FIRESTORE (lógica existente) ---
      // Esta parte sigue capturando tanto la entrada del usuario como la respuesta final del bot
      // Nota: botResponse aquí podría ser una cadena vacía si se envió un mensaje interactivo
      try {
        await db.collection('conversations').add({
          phoneNumber: from,
          userMessage: userMessage,
          botResponse: botResponse, // La última respuesta de texto generada por el bot (no interactiva)
          timestamp: timestamp,
          messageId: messageId
        });
        console.log('💾 Conversación guardada en Firestore.');
      } catch (dbError) {
        console.error('❌ ERROR al guardar en Firestore:', dbError.message);
      }

    
