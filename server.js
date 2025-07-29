import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// --- CONFIGURAÇÕES ---
const BUCK_PAY_API_KEY = process.env.BUCK_PAY_API_KEY;
const BUCK_PAY_CREATE_TRANSACTION_URL = process.env.BUCK_PAY_URL || "https://api.realtechdev.com.br/v1/transactions";

// CONFIG UTMify
const UTMIFY_URL = "https://api.utmify.com.br/api-credentials/orders";
const UTMIFY_TOKEN = process.env.UTMIFY_TOKEN || "SEU_TOKEN_REAL_AQUI"; // Certifique-se de que este é o token REAL no Render!

if (!BUCK_PAY_API_KEY) {
    console.error("Erro: Variável de ambiente BUCK_PAY_API_KEY não configurada no Render.");
    process.exit(1);
}
if (UTMIFY_TOKEN === "SEU_TOKEN_REAL_AQUI" && !process.env.UTMIFY_TOKEN) {
    console.warn("Aviso: Variável de ambiente UTMIFY_TOKEN não configurada e token hardcoded ainda é o placeholder. Configure-o!");
}


// --- ARMAZENAMENTO TEMPORÁRIO EM MEMÓRIA ---
// Chave: externalId
// Valor: {
//    createdAt: Date,
//    buckpayId: string,
//    status: string (e.g., 'pending', 'paid', 'expired', 'refunded')
//    tracking: object,
//    customer: object,
//    product: object,
//    offer: object,
//    amountInCents: number,
//    gatewayFee: number, // Armazenará a taxa de gateway
//    utmifyNotifiedStatus: Map<string, boolean> // NOVO: Para rastrear quais status já foram enviados para UTMify
// }
const pendingTransactions = new Map();
const TRANSACTION_LIFETIME_MINUTES = 35;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function cleanupTransactionsInMemory() {
    const now = new Date();
    for (const [externalId, transactionInfo] of pendingTransactions.entries()) {
        const elapsedTimeMinutes = (now.getTime() - transactionInfo.createdAt.getTime()) / (1000 * 60);

        if (transactionInfo.status !== 'pending' || elapsedTimeMinutes > TRANSACTION_LIFETIME_MINUTES) {
            pendingTransactions.delete(externalId);
            console.log(`🧹 Transação ${externalId} (status: ${transactionInfo.status || 'sem status final'}) removida da memória após ${elapsedTimeMinutes.toFixed(0)} minutos.`);
        }
    }
}

setInterval(cleanupTransactionsInMemory, CLEANUP_INTERVAL_MS);
console.log(`Limpeza de transações agendada a cada ${CLEANUP_INTERVAL_MS / 1000 / 60} minutos.`);
// --- FIM DO ARMAZENAMENTO TEMPORÁRIO ---

// --- FUNÇÃO PARA ENVIAR PARA UTMify (Refatorada para reuso) ---
async function sendToUTMify(orderData, externalId, trackingParameters, status, customerData, productData, offerData, gatewayFee) {
    console.log(`[UTMify] Tentando enviar status '${status}' para orderId: ${externalId}`);

    // Aqui, orderData.amountInCents deve ser o valor total do pedido.
    // userCommission é o valor total menos a taxa do gateway.
    let userCommission = orderData.amountInCents - (gatewayFee || 0);
    // Garante que a comissão seja pelo menos 1 centavo para 'paid' se o valor original for > 0
    if (status === 'paid' && orderData.amountInCents > 0 && userCommission <= 0) {
        userCommission = 1;
    }

    const bodyForUTMify = {
        orderId: externalId,
        platform: "FreeFireCheckout",
        paymentMethod: "pix",
        status: status,
        createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        approvedDate: status === 'paid' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
        customer: {
            name: customerData?.name || "Cliente",
            email: customerData?.email || "cliente@teste.com",
            phone: customerData?.phone || "",
            document: customerData?.document || "",
            country: "BR"
        },
        products: [
            {
                id: productData?.id || "recarga-ff",
                name: productData?.name || "Recarga Free Fire",
                quantity: offerData?.quantity || 1,
                priceInCents: orderData.amountInCents || 0, // Usar o valor total original
                planId: offerData?.id || "basic",
                planName: offerData?.name || "Plano Básico"
            }
        ],
        commission: {
            totalPriceInCents: orderData.amountInCents || 0, // Valor total do pedido
            gatewayFeeInCents: gatewayFee, // Taxa do gateway
            userCommissionInCents: userCommission // Comissão líquida para o afiliado/usuário
        },
        trackingParameters: {
            utm_campaign: trackingParameters?.utm_campaign || "",
            utm_content: trackingParameters?.utm_content || "",
            utm_medium: trackingParameters?.utm_medium || "",
            utm_source: trackingParameters?.utm_source || "",
            utm_term: trackingParameters?.utm_term || "",
            cid: trackingParameters?.cid || externalId
        },
        isTest: false
    };

    console.log(`[UTMify] Payload FINAL para '${status}':`, JSON.stringify(bodyForUTMify, null, 2));

    try {
        const responseUTMify = await fetch(UTMIFY_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-token": UTMIFY_TOKEN
            },
            body: JSON.stringify(bodyForUTMify)
        });

        const resultUTMify = await responseUTMify.json();
        if (!responseUTMify.ok) {
            console.error(`[UTMify Error] Status: ${responseUTMify.status}, Resposta:`, resultUTMify);
            return false; // Indica falha no envio
        } else {
            console.log("[UTMify] Resposta:", resultUTMify);
            return true; // Indica sucesso no envio
        }
    } catch (utmifyError) {
        console.error("[UTMify Error] Erro ao enviar dados para UTMify:", utmifyError);
        return false; // Indica falha no envio
    }
}
// --- FIM DA FUNÇÃO UTMify ---


// --- MIDDLEWARES ---
app.use(cors({
    origin: 'https://freefirereward.site', // Permita apenas o seu frontend
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// --- ROTAS ---

app.get("/", (req, res) => {
    res.send("Servidor PagueEasy está online!");
});

app.get("/my-server-ip", async (req, res) => {
    try {
        const response = await fetch("https://api.ipify.org?format=json");
        const data = await response.json();
        res.json({ ip: data.ip });
    } catch (error) {
        console.error("Erro ao obter IP:", error);
        res.status(500).json({ error: "Erro ao obter IP do servidor" });
    }
});

// Rota para criar transação PIX via BuckPay
app.post("/create-payment", async (req, res) => {
    const { amount, email, name, document, phone, product_id, product_name, offer_id, offer_name, discount_price, quantity, tracking } = req.body;

    if (!amount || !email || !name) {
        return res.status(400).json({ error: "Dados obrigatórios (amount, email, name) estão faltando." });
    }

    const externalId = `order_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    console.log(`Gerando pagamento para ${email} com externalId: ${externalId}`);

    const amountInCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountInCents) || amountInCents < 500) {
        return res.status(400).json({ error: "Valor de pagamento inválido ou abaixo do mínimo de R$5,00." });
    }

    // --- Tratamento do CPF para garantir que seja válido para a BuckPay ---
    let buyerDocument = document; // Pega o que veio do frontend
    if (buyerDocument) {
        buyerDocument = buyerDocument.replace(/\D/g, ''); // Remove caracteres não numéricos
    }
    
    // Se o documento não foi fornecido pelo frontend, ou está vazio após limpeza, use um CPF de teste válido.
    if (!buyerDocument || buyerDocument.length === 0) {
        buyerDocument = "00000000000"; // Tentar outro CPF de teste
        console.warn(`[CREATE PAYMENT] CPF não fornecido ou vazio pelo frontend. Usando CPF de teste: ${buyerDocument}`);
    } else {
        // Opcional: Adicionar uma validação básica se o CPF do frontend não for o de teste
        // (Isso é menos crítico se o BuckPay validar o CPF do comprador)
        // Por exemplo, se quiser garantir que CPFs com todos os dígitos iguais sejam convertidos para o de teste
        if (/^(.)\1+$/.test(buyerDocument) && buyerDocument.length === 11) {
             buyerDocument = "11111111111"; // Força o CPF de teste se o gerado for "11111111111", "22222222222" etc.
             console.warn(`[CREATE PAYMENT] CPF gerado pelo frontend é sequencial. Usando CPF de teste: ${buyerDocument}`);
        }
    }
    // --- FIM DO TRATAMENTO DO CPF ---

    let cleanPhone = phone ? phone.replace(/\D/g, '') : '';
    if (cleanPhone.length > 0 && !cleanPhone.startsWith('55')) {
        if (cleanPhone.length === 9) {
            cleanPhone = `5511${cleanPhone}`;
        } else if (cleanPhone.length === 10 || cleanPhone.length === 11) {
            cleanPhone = `55${cleanPhone}`;
        }
    }
    if (cleanPhone.length < 12) {
        cleanPhone = "5511987654321"; // Telefone de fallback
    }
    cleanPhone = cleanPhone.substring(0, 13); // Garante o formato 55DDD9XXXXXXXX

    let offerPayload = null;
    if (!offer_id && !offer_name && (discount_price === null || discount_price === undefined)) {
        offerPayload = null;
    } else {
        offerPayload = {
            id: offer_id || "default_offer_id",
            name: offer_name || "Oferta Padrão",
            discount_price: (discount_price !== null && discount_price !== undefined) ? Math.round(parseFloat(discount_price) * 100) : 0,
            quantity: quantity || 1
        };
    }

    let buckpayTracking = {};
    buckpayTracking.utm_source = tracking?.utm_source || 'direct';
    buckpayTracking.utm_medium = tracking?.utm_medium || 'website';
    buckpayTracking.utm_campaign = tracking?.utm_campaign || 'no_campaign';
    buckpayTracking.src = tracking?.utm_source || 'direct';
    buckpayTracking.utm_id = tracking?.xcod || tracking?.cid || externalId;
    buckpayTracking.ref = tracking?.cid || externalId;
    buckpayTracking.sck = tracking?.sck || 'no_sck_value';
    buckpayTracking.utm_term = tracking?.utm_term || '';
    buckpayTracking.utm_content = tracking?.utm_content || '';

    const payload = {
        external_id: externalId,
        payment_method: "pix",
        amount: amountInCents,
        buyer: {
            name: name,
            email: email,
            document: buyerDocument, // <--- AGORA USA O CPF TRATADO!
            phone: cleanPhone
        },
        product: product_id && product_name ? { id: product_id, name: product_name } : null,
        offer: offerPayload,
        tracking: buckpayTracking
    };

    console.log("Payload FINAL enviado para BuckPay:", JSON.stringify(payload, null, 2));

    try {
        const response = await fetch(BUCK_PAY_CREATE_TRANSACTION_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${BUCK_PAY_API_KEY}`,
                "User-Agent": "Buckpay API"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorDetails = await response.text();
            console.error(`Erro ao criar pagamento na BuckPay (HTTP status ${response.status}):`, errorDetails);
            return res.status(response.status).json({
                success: false,
                error: "Erro ao criar pagamento na BuckPay.",
                details: errorDetails,
                http_status: response.status
            });
        }

        const data = await response.json();
        console.log("Resposta da BuckPay:", JSON.stringify(data, null, 2));

        if (data.data && data.data.pix && data.data.pix.qrcode_base64) {
            // Inicializa utmifyNotifiedStatus
            const utmifyNotifiedStatus = new Map();

            pendingTransactions.set(externalId, {
                createdAt: new Date(),
                buckpayId: data.data.id,
                status: 'pending',
                tracking: tracking,
                customer: { name, email, document: buyerDocument, phone: cleanPhone }, // Salva o CPF TRATADO
                product: product_id && product_name ? { id: product_id, name: product_name } : null,
                offer: offerPayload,
                amountInCents: amountInCents,
                gatewayFee: 0, // Inicializa com 0
                utmifyNotifiedStatus: utmifyNotifiedStatus // Adiciona o mapa de notificação
            });
            console.log(`Transação ${externalId} (BuckPay ID: ${data.data.id}) registrada em memória como 'pending'.`);

            // --- Enviar para UTMify com status "waiting_payment" ---
            const sent = await sendToUTMify(
                { amountInCents: amountInCents },
                externalId,
                tracking,
                "waiting_payment", // Status para UTMify
                { name, email, document: buyerDocument, phone: cleanPhone }, // Envia o CPF TRATADO
                product_id && product_name ? { id: product_id, name: product_name } : null,
                offerPayload,
                0 // Gateway fee é 0 para waiting_payment
            );

            if (sent) {
                utmifyNotifiedStatus.set("waiting_payment", true);
            }

            res.status(200).json({
                pix: {
                    code: data.data.pix.code,
                    qrcode_base64: data.data.pix.qrcode_base64
                },
                transactionId: externalId
            });
        } else {
            console.error("Resposta inesperada da BuckPay (sem PIX):", data);
            res.status(500).json({ success: false, error: "Resposta inesperada da BuckPay (PIX não gerado)." });
        }

    } catch (error) {
        console.error("Erro ao processar criação de pagamento (requisição BuckPay):", error);
        res.status(500).json({ success: false, error: "Erro interno ao criar pagamento." });
    }
});

// Rota de Webhook da BuckPay (recebe notificações de status da BuckPay)
app.post("/webhook/buckpay", async (req, res) => {
    // --- START FULL BUCKPAY WEBHOOK BODY (para depuração) ---
    console.log("--- START FULL BUCKPAY WEBHOOK BODY ---");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("--- END FULL BUCKPAY WEBHOOK BODY ---");

    const event = req.body.event;
    const data = req.body.data;

    let externalIdFromWebhook = data.tracking?.ref || data.tracking?.utm_id || data.external_id;
    const currentBuckpayStatus = data.status;
    const gatewayFeeFromWebhook = data.fees?.gateway_fee || 0; // Tenta pegar a taxa se existir

    console.log(`🔔 Webhook BuckPay recebido: Evento '${event}', Status '${currentBuckpayStatus}', ID BuckPay: '${data.id}', External ID: '${externalIdFromWebhook}'`);

    if (!externalIdFromWebhook) {
        console.warn("Webhook recebido sem externalId reconhecível. Ignorando.");
        return res.status(200).send("Webhook recebido (externalId não encontrado).");
    }

    let transactionInfo = pendingTransactions.get(externalIdFromWebhook);

    // --- Cenário 1: Transação NÃO está em memória ---
    if (!transactionInfo) {
        console.warn(`Webhook para externalId ${externalIdFromWebhook} recebido, mas transação NÃO ENCONTRADA EM MEMÓRIA. Isso pode significar que expirou, foi concluída e limpa, ou nunca existiu.`);

        // Se for um status 'paid' e não temos a transação em memória,
        // é uma última chance de enviar para a UTMify para não perder a conversão.
        // Assumimos que a informação do webhook é a mais completa aqui.
        if (currentBuckpayStatus === 'paid') {
            console.warn(`Tentando enviar status 'paid' para UTMify mesmo sem encontrar transação em memória: ${externalIdFromWebhook}`);
            await sendToUTMify(
                { amountInCents: data.amount || 0 }, // Usar amount do webhook
                externalIdFromWebhook,
                data.tracking, // Usar tracking do webhook
                "paid",
                data.buyer, // Usar buyer do webhook
                data.product, // Usar product do webhook
                data.offer, // Usar offer do webhook
                gatewayFeeFromWebhook // Usar gatewayFee do webhook
            );
        }
        return res.status(200).send("Webhook recebido com sucesso (transação não encontrada em memória).");
    }

    // --- Cenário 2: Transação ESTÁ em memória ---

    // 1. Sempre atualiza o gatewayFee se o webhook o fornecer
    if (gatewayFeeFromWebhook > 0) {
        transactionInfo.gatewayFee = gatewayFeeFromWebhook;
        console.log(`Gateway Fee para ${externalIdFromWebhook} atualizado em memória para ${transactionInfo.gatewayFee}.`);
    }

    // 2. Garante que os dados mais recentes do webhook BuckPay estejam na memória
    transactionInfo.buckpayId = data.id;
    transactionInfo.customer = data.buyer || transactionInfo.customer;
    transactionInfo.product = data.product || transactionInfo.product;
    transactionInfo.offer = data.offer || transactionInfo.offer;
    transactionInfo.amountInCents = data.amount || transactionInfo.amountInCents;


    // 3. Lógica para enviar para UTMify apenas quando necessário (idempotência aprimorada)
    let shouldSendToUTMify = false;
    let utmifyStatusToSend = currentBuckpayStatus; // Por padrão, o status do webhook

    if (transactionInfo.status !== currentBuckpayStatus) {
        // Se o status mudou na BuckPay, sempre tentamos notificar a UTMify
        console.log(`Status da transação ${externalIdFromWebhook} MUDOU de '${transactionInfo.status}' para '${currentBuckpayStatus}'.`);
        transactionInfo.status = currentBuckpayStatus; // Atualiza o status em memória
        shouldSendToUTMify = true;
    } else {
        // Se o status NÃO mudou (webhook duplicado para o mesmo status)
        console.log(`❕ Webhook para ${externalIdFromWebhook} recebido, mas status '${currentBuckpayStatus}' já é o mesmo em memória.`);
        // Para o status 'paid', se já notificamos a UTMify, não enviamos novamente.
        // Isso é crucial para evitar múltiplas notificações 'paid'.
        if (currentBuckpayStatus === 'paid') {
            if (transactionInfo.utmifyNotifiedStatus.get("paid")) {
                console.log(`   --> Status 'paid' já foi notificado para UTMify para ${externalIdFromWebhook}. Ignorando re-envio.`);
                shouldSendToUTMify = false; // Não envia novamente
            } else {
                // Caso raro: o status em memória já é 'paid', mas não marcamos como notificado para UTMify.
                // Isso pode acontecer se o servidor cair entre a atualização do status e a marcação de notificado.
                console.warn(`   --> Status 'paid' em memória, mas não marcado como notificado. Tentando enviar para UTMify.`);
                shouldSendToUTMify = true;
            }
        }
        // Para outros status duplicados ('pending', 'expired', etc.), geralmente não é necessário re-enviar,
        // já que o primeiro envio de `waiting_payment` já foi feito pelo `/create-payment`.
        // A UTMify geralmente só precisa de `waiting_payment` e depois o status final (`paid`, `refunded`, etc.).
        else {
            shouldSendToUTMify = false;
        }
    }

    if (shouldSendToUTMify) {
        // Se decidimos enviar para UTMify
        const sent = await sendToUTMify(
            { amountInCents: transactionInfo.amountInCents },
            externalIdFromWebhook,
            transactionInfo.tracking,
            utmifyStatusToSend, // O status para enviar
            transactionInfo.customer,
            transactionInfo.product,
            transactionInfo.offer,
            transactionInfo.gatewayFee // Usar o gatewayFee mais atualizado
        );

        if (sent) {
            // Marca que este status foi notificado com sucesso para a UTMify
            transactionInfo.utmifyNotifiedStatus.set(utmifyStatusToSend, true);
        }
    }

    // Sempre envia 200 OK para a BuckPay para que ela não retransmita o webhook.
    res.status(200).send("Webhook recebido com sucesso!");
});

// Rota de Consulta de Status para o Frontend (Lendo APENAS do Map em Memória)
app.get("/check-order-status", async (req, res) => {
    const externalId = req.query.id;

    if (!externalId) {
        return res.status(400).json({ error: "ID externo da transação não fornecido." });
    }

    const transactionInfo = pendingTransactions.get(externalId);
    const now = new Date();

    if (transactionInfo) {
        const elapsedTimeMinutes = (now.getTime() - transactionInfo.createdAt.getTime()) / (1000 * 60);

        if (transactionInfo.status === 'pending' && elapsedTimeMinutes > 30) {
            transactionInfo.status = 'expired';
            console.log(`Transação ${externalId} marcada como 'expired' em memória (tempo de Pix excedido).`);
            // Nota: Não enviamos 'expired' para UTMify aqui. Idealmente, o webhook da BuckPay fará isso.
        }

        console.log(`Retornando status em memória para ${externalId}: ${transactionInfo.status}`);
        return res.status(200).json({ success: true, status: transactionInfo.status });

    } else {
        console.warn(`Consulta para externalId ${externalId}, mas transação NÃO ENCONTRADA EM MEMÓRIA. Isso pode significar que expirou, foi concluída e limpa, ou nunca existiu.`);
        return res.status(200).json({ success: true, status: 'not_found_or_expired' });
    }
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));