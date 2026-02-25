const axios = require("axios");

const clean = (data) => {
  if (!data) return "";
  let regex = /(<([^>]+)>)/gi;
  data = data.replace(/(<br?\s?\/>)/gi, "\n");
  return data.replace(regex, "");
};

async function shortener(url) {
  return url || "";
}

exports.Tiktok = async (query) => {
  try {
    const response = await axios.post(
      "https://lovetik.com/api/ajax/search",
      new URLSearchParams({ query }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      }
    );

    const data = response.data;

    if (!data || !data.links || data.links.length === 0) {
      throw new Error("Links do TikTok não encontrados");
    }

    const result = {
      creator: "Tosh DFS TECH",
      title: clean(data.desc),
      author: clean(data.author),
      nowm: await shortener((data.links[0]?.a || "").replace("https", "http")),
      watermark: await shortener((data.links[1]?.a || "").replace("https", "http")),
      audio: await shortener((data.links[2]?.a || "").replace("https", "http")),
      thumbnail: await shortener(data.cover || ""),
    };

    return result;
  } catch (err) {
    console.error("Erro no scraper TikTok:", err.message);
    return { erro: "Erro ao carregar vídeo", detalhes: err.message };
  }
};
