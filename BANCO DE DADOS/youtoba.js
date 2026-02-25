const fetch = require('node-fetch')
const yts = require('yt-search')
const ytdl = require('@distube/ytdl-core')
const moment = require('moment-timezone')
async function FormatoTEMPO(seconds) {
const Minutos = Math.floor(seconds / 60)
const Segundos = seconds % 60
return `${Minutos.toString().padStart(2, '0')}:${Segundos.toString().padStart(2, '0')}`
}
const cookies = (() => { try { return JSON.parse(process.env.YTDL_COOKIES_JSON || "[]"); } catch { return []; } })();

const agentOptions = {
  pipelining: 5,
  maxRedirections: 0,
  localAddress: "127.0.0.1",
};

const agent = ytdl.createAgent(cookies, agentOptions);

async function YTNomeSearch(query, videoQuality = 'lowest', audioQuality = 'lowestaudio') {
try {
const ProcurarResults = await yts(query)
if (ProcurarResults.videos.length > 0) {
const VideoInfo = await ytdl.getInfo(ProcurarResults.videos[0].url, {
quality: videoQuality,
filter: 'videoandaudio',
},{ agent })
const SegundosTEMPO = VideoInfo.videoDetails.lengthSeconds
const Duração = await FormatoTEMPO(SegundosTEMPO)

const AudioInfo = await ytdl.getInfo(ProcurarResults.videos[0].url, {
quality: audioQuality,
filter: 'audioonly',
},{ agent })

const { thumbnail, title, author, url } = ProcurarResults.videos[0]
            
return {
thumb: thumbnail,
title: title,
channel: author.name,
duration: Duração,
views: VideoInfo.videoDetails.viewCount,
publishedDate: moment(VideoInfo.videoDetails.publishDate).format('DD-MM-YYYY'),
audiourl: AudioInfo.formats.find(format => format.audioBitrate).url,
url: VideoInfo.formats.find(format => format.qualityLabel && format.audioBitrate).url,
urlOriginal: url,
}
} else {
console.log('Nenhum vídeo encontrado para a pesquisa.')
}
} catch (erro) {
console.log('Erro ao processar a solicitação: ' + erro)
}
}


module.exports = {
YTNomeSearch
}