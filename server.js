const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000; // Usa a porta do Render, ou 3000 para desenvolvimento local

app.use(cors());
app.use(bodyParser.json());

// ATENÇÃO: É altamente recomendável usar variáveis de ambiente para chaves sensíveis.
// Ex: process.env.BUCKPAY_API_TOKEN
// Se você configurou BUCKPAY_API_TOKEN como variável de ambiente no Render, use process.env.BUCKPAY_API_TOKEN
const BUCKPAY_API_TOKEN = process.env.BUCKPAY_API_TOKEN || 'sk_live_69b0ed89aaa545ef5e67bfcef2c3e0c4'; 
const BUCKPAY_API_ENDPOINT = 'https://api.realtechdev.com.br/v1/transactions';

// --- Endpoint para Gerar Pix ---
app.post('/gerar-pix', async (req, res) => {
  // Recebe dados do frontend, incluindo o external_id gerado no frontend
  const { valor, nome, email, cpf, telefone, external_id } = req.body;

  // Validação básica: Verifique se os campos essenciais estão presentes
  if (!valor || !nome || !email || !external_id) {
    return res.status(400).json({
      success: false,
      message: 'Campos obrigatórios faltando: valor, nome, email, external_id.'
    });
  }

  // Preparar os dados para a API da Buckpay
  const dadosTransacaoBuckpay = {
    external_id: external_id, // Identificador único da sua transação (vindo do frontend)
    payment_method: "pix",
    amount: valor, // Valor em centavos
    // *** CORREÇÃO AQUI: 'buyer' agora é 'buyers' e é um array de objetos ***
    buyers: [ 
      {
        name: nome,
        email: email,
        document: cpf ? cpf.replace(/\D/g, '') : undefined, // Remove pontos e hífens do CPF
        phone: telefone ? telefone.replace(/\D/g, '') : undefined // Remove formatação do telefone
      }
    ],
    // Você pode adicionar 'product', 'offer', 'tracking' aqui se necessário.
    // Consulte a documentação da Buckpay para os formatos corretos.
  };

  try {
    // Enviar a requisição para a API da Buckpay
    const response = await axios.post(BUCKPAY_API_ENDPOINT, dadosTransacaoBuckpay, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BUCKPAY_API_TOKEN}`,
        'User-Agent': 'Buckpay API'
      }
    });

    // Depuração - Imprimir a resposta da API da Buckpay
    console.log('Resposta da API Buckpay (/gerar-pix):', response.data);

    // A Buckpay retorna um objeto 'data' com 'pix' dentro se for sucesso
    if (response.data && response.data.data && response.data.data.pix) {
      return res.json({
        success: true,
        transaction_id: response.data.data.id, // ID interno da transação na Buckpay
        pixCode: response.data.data.pix.code,         // Chave Pix Copia e Cola
        qrcode_base64: response.data.data.pix.qrcode_base64, // Imagem do QR Code em base64
        external_id: external_id // Retorna o external_id original para o frontend
      });
    } else {
      // Se não houver 'data' ou 'pix', é um formato de erro não mapeado ou sucesso inesperado
      return res.status(400).json({
        success: false,
        message: 'Erro inesperado na resposta da Buckpay ao gerar Pix.',
        errorDetails: response.data,
      });
    }
  } catch (error) {
    // Depuração - Verificar o erro detalhado da Buckpay
    console.error('Erro na comunicação com a API Buckpay (/gerar-pix):', error.response ? error.response.data : error.message);

    // Tratamento de erros específicos da Buckpay (400, 401, 500)
    if (error.response) {
      const { status, data } = error.response;
      return res.status(status).json({
        success: false,
        message: data.error ? data.error.message : 'Erro na requisição para Buckpay.',
        errorDetails: data.error ? data.error.detail : data,
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor ou falha de conexão.',
        errorDetails: error.message,
      });
    }
  }
});

// --- Endpoint para Verificação de Status do Pix ---
app.get('/status-pix/:external_id', async (req, res) => {
  const { external_id } = req.params;

  // Validação básica
  if (!external_id) {
    return res.status(400).json({
      success: false,
      message: 'O ID externo (external_id) é obrigatório para verificar o status.'
    });
  }

  try {
    // Faz a requisição GET para a API da Buckpay usando o external_id
    const response = await axios.get(`${BUCKPAY_API_ENDPOINT}/external_id/${external_id}`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BUCKPAY_API_TOKEN}`, // Use o mesmo token
        'User-Agent': 'Buckpay API'
      }
    });

    console.log('Resposta da API Buckpay (status):', response.data);

    // Verifica se a resposta contém os dados esperados da Buckpay
    if (response.data && response.data.data) {
      // Retorna o status da transação para o frontend
      return res.json({
        success: true,
        status: response.data.data.status, // Ex: "pending", "paid", "canceled"
        transaction_id: response.data.data.id, // ID da transação da Buckpay
        amount: response.data.data.total_amount, // Valor da transação
      });
    } else {
      // Se o formato da resposta não for o esperado
      return res.status(404).json({
        success: false,
        message: 'Transação não encontrada ou formato de resposta inesperado da Buckpay.',
        errorDetails: response.data,
      });
    }
  } catch (error) {
    // Tratamento de erros na comunicação com a Buckpay para a verificação de status
    console.error('Erro ao verificar status da Buckpay:', error.response ? error.response.data : error.message);

    if (error.response) {
      const { status, data } = error.response;
      // Retorna o erro exato da Buckpay se disponível
      return res.status(status).json({
        success: false,
        message: data.error ? data.error.message : 'Erro ao consultar status da transação na Buckpay.',
        errorDetails: data.error ? data.error.detail : data,
      });
    } else {
      // Erros de rede ou outros problemas
      return res.status(500).json({
        success: false,
        message: 'Erro interno do servidor ao tentar verificar status.',
        errorDetails: error.message,
      });
    }
  }
});

// --- Inicia o Servidor ---
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});