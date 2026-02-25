const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('qs');

async function PinterestVideo(url) {
  return new Promise(async (resolve, reject) => {
    if (!url || !url.includes('pinterest.')) {
      return reject({ status: 400, error: 'URL inválida do Pinterest.' });
    }

    try {
      const response = await axios.post(
        'https://pinterestvideodownloader.com/',
        qs.stringify({ url }),
        {
          headers: {
            'user-agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.5195.136 Mobile Safari/537.36',
            'content-type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const $ = cheerio.load(response.data);
      const videoUrl = $('a[style*="background-color: green"]').attr('href'); // Melhor flexibilidade

      if (!videoUrl) {
        return reject({ status: 404, error: 'Vídeo não encontrado no HTML.' });
      }

      resolve({
        status: 200,
        code_by: '@VNCSCODE - 73999197974',
        download_vid: videoUrl
      });

    } catch (error) {
      reject({
        status: 500,
        error: 'Erro ao acessar PinterestVideoDownloader.',
        detalhes: error.message
      });
    }
  });
}

module.exports = { PinterestVideo };
