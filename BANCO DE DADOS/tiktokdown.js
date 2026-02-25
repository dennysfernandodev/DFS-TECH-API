const axios = require("axios")

// 🔹 Resolve links curtos
async function resolveTikTokUrl(url) {
  try {
    const response = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    })
    return response.headers.location || url
  } catch {
    return url
  }
}

// 🔹 Função principal
async function TiktokDownload(url, noWatermark = false) {
  try {
    url = await resolveTikTokUrl(url)

    const { data } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    })

    let match = data.match(
      /<script id="SIGI_STATE" type="application\/json">(.*?)<\/script>/
    )
    let jsonData = null

    if (match) {
      jsonData = JSON.parse(match[1])
    } else {
      match = data.match(
        /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/
      )
      if (match) jsonData = JSON.parse(match[1])
    }

    if (!jsonData) throw new Error("JSON do TikTok não encontrado")

    let videoData = null
    if (jsonData.ItemModule) {
      const videoId = Object.keys(jsonData.ItemModule)[0]
      videoData = jsonData.ItemModule[videoId]
    } else if (jsonData.props?.pageProps?.itemInfo?.itemStruct) {
      videoData = jsonData.props.pageProps.itemInfo.itemStruct
    }

    if (!videoData) throw new Error("Vídeo não encontrado")

    return {
      status: 200,
      link: url,
      video: noWatermark
        ? videoData.video?.playAddr
        : videoData.video?.downloadAddr || videoData.video?.playAddr,
      audio: videoData.music?.playUrl || null,
      thumbnail: videoData.video?.cover || videoData.video?.dynamicCover,
      description: videoData.desc,
      author:
        videoData.author?.uniqueId ||
        videoData.author?.nickname ||
        "Desconhecido",
    }
  } catch (err) {
    return { status: 500, error: err.message || "Erro desconhecido" }
  }
}

// 🔹 Exporta as duas funções corretamente
module.exports = { TiktokDownload, resolveTikTokUrl }
