const axios = require('axios');
const cheerio = require('cheerio');

const mediafireDl = async (url) => {
  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.mediafire.com/',
      },
    });

    const $ = cheerio.load(data);

    // Link direto do botão
    const downloadBtn = $('a#downloadButton').attr('href');
    if (!downloadBtn) {
      return {
        status: false,
        erro: 'Falha ao processar link do MediaFire',
        detalhes: 'Botão de download não encontrado. Talvez o link não seja público.',
      };
    }

    // Nome do arquivo (vem no botão ou no título da página)
    let nome = $('div.filename').text().trim();
    if (!nome) {
      const parts = downloadBtn.split('/');
      nome = decodeURIComponent(parts[parts.length - 1]);
    }

    // Tamanho (vem no span abaixo do botão)
    const size = $('div.dl-info > ul > li:nth-child(2)').text().trim() ||
                 $('a#downloadButton').text().replace(/Download|\(|\)|\n/g, '').trim();

    // Mime
    const mime = nome.includes('.') ? nome.split('.').pop() : 'desconhecido';

    return {
      status: true,
      source: 'mediafire',
      nome,
      mime,
      tamanho: size,
      link: downloadBtn,
    };
  } catch (err) {
    return {
      status: false,
      erro: 'Falha ao processar link do MediaFire',
      detalhes: err.message,
    };
  }
};

module.exports = { mediafireDl };
