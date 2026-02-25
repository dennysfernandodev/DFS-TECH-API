const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const moment = require('moment-timezone');

/**
 * Formata segundos em MM:SS
 */
async function formatarTempo(seconds) {
  const minutos = Math.floor(seconds / 60);
  const segundosRestantes = seconds % 60;
  return `${minutos.toString().padStart(2, '0')}:${segundosRestantes.toString().padStart(2, '0')}`;
}

/**
 * Busca no YouTube e retorna info de áudio/vídeo
 */
async function YTNomeSearch(query, videoQuality = 'lowest', audioQuality = 'lowestaudio') {
  try {
    const resultados = await yts(query);

    if (!resultados.videos || resultados.videos.length === 0) {
      return { error: 'Nenhum vídeo encontrado para a pesquisa.' };
    }

    const video = resultados.videos[0];

    // Pega info do vídeo
    let videoInfo;
    try {
      videoInfo = await ytdl.getInfo(video.url);
    } catch (err) {
      return { error: 'Falha ao obter informações do vídeo. O host pode estar bloqueando o acesso ao YouTube.' };
    }

    const duracao = await formatarTempo(parseInt(videoInfo.videoDetails.lengthSeconds));

    const audioFormat = ytdl
      .filterFormats(videoInfo.formats, 'audioonly')
      .find(f => f.audioBitrate);
    const videoAudioFormat = ytdl
      .filterFormats(videoInfo.formats, 'videoandaudio')
      .find(f => f.qualityLabel && f.audioBitrate);

    return {
      thumb: video.thumbnail,
      title: video.title,
      channel: video.author.name,
      duration: duracao,
      views: videoInfo.videoDetails.viewCount,
      publishedDate: moment(videoInfo.videoDetails.publishDate).format('DD-MM-YYYY'),
      audiourl: audioFormat ? audioFormat.url : null,
      url: videoAudioFormat ? videoAudioFormat.url : null,
      urlOriginal: video.url
    };
  } catch (erro) {
    console.error('Erro ao processar a solicitação:', erro.message);
    return { error: 'Erro interno ao buscar vídeo. ' + erro.message };
  }
}

module.exports = {
  YTNomeSearch
};
