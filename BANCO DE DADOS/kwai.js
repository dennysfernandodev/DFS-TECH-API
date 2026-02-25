// hdImagem.js
import express from "express";
import fetch from "node-fetch";
import Jimp from "jimp";
import FormData from "form-data";
import fs from "fs";
import path from "path";

const router = express.Router();
const rota = "/api/ai/hd/imagem";

// 🧠 Função auxiliar: upload Catbox
async function uploadCatbox(buffer) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", buffer, {
    filename: "imagem_hd.jpg",
    contentType: "image/jpeg",
  });

  const res = await fetch("https://catbox.moe/user/api.php", {
    method: "POST",
    body: form,
  });

  const link = (await res.text()).trim();
  if (!link.startsWith("http")) throw new Error("Falha no upload Catbox");
  return link;
}

// 🚏 Rota principal
router.get("/ai/hd/imagem", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url)
      return res.status(400).json({ rota, erro: "Parâmetro 'url' é obrigatório" });

    // 1️⃣ Baixar imagem
    const response = await fetch(url);
    if (!response.ok)
      return res.status(400).json({ rota, erro: "Não foi possível baixar a imagem" });

    const buffer = Buffer.from(await response.arrayBuffer());

    // 2️⃣ Aumentar resolução com Jimp (2x)
    const image = await Jimp.read(buffer);
    image.resize(image.bitmap.width * 2, image.bitmap.height * 2, Jimp.RESIZE_BICUBIC);
    image.quality(95);
    const hdBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);

    // 3️⃣ Upload para Catbox
    const linkHD = await uploadCatbox(hdBuffer);

    // ✅ Retorno
    return res.json({
      rota,
      status: true,
      mensagem: "Imagem aprimorada com sucesso",
      imagem_hd: linkHD,
    });
  } catch (err) {
    console.error("Erro:", err);
    return res.status(500).json({
      rota,
      status: false,
      erro: "Erro ao processar imagem",
      detalhes: err.message,
    });
  }
});

export default router;