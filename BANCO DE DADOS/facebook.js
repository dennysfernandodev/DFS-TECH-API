const { exec } = require("child_process");
const path = require("path");

function fbDownloader(url, format = "mp3") {
    return new Promise((resolve, reject) => {
        if (!url) return reject("Informe a URL do vídeo.");

        const ext = format === "mp3" ? "mp3" : "mp4";
        const filename = `fb_${Date.now()}.${ext}`;
        const filepath = path.join(__dirname, "temp", filename);

        let cmd;
        if (format === "mp3") {
            // Extrai áudio
            cmd = `yt-dlp -x --audio-format mp3 -o "${filepath}" "${url}"`;
        } else {
            // Baixa vídeo
            cmd = `yt-dlp -f best -o "${filepath}" "${url}"`;
        }

        exec(cmd, (err, stdout, stderr) => {
            if (err) return reject(stderr || err);
            resolve({ file: filepath });
        });
    });
}

module.exports = fbDownloader; // ✅ Exporta a função corretamente
