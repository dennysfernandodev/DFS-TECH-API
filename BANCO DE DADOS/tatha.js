const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const __path = process.cwd();
const lib = path.join(__path, 'lib');
const tmp = path.join(__path, 'tmp');
const _font = path.join(lib, 'font');
const aesthetic = path.join(lib, 'Aesthetic');

/**
 * Gera uma imagem Tahta estilizada com texto e efeitos visuais.
 * @param {Object} options - Opções de configuração
 * @param {string} options.text - Texto principal a renderizar
 * @param {string} [options.backgroundImage] - Caminho de imagem de fundo
 * @param {string} [options.font] - Caminho da fonte
 * @param {number} [options.width=1024] - Largura da imagem
 * @param {number} [options.height=1024] - Altura da imagem
 * @param {string} [options.color='white'] - Cor do texto
 * @param {string} [options.bgColor='black'] - Cor de fundo do texto
 * @param {number} [options.fontSize] - Tamanho da fonte (calculado automaticamente se não definido)
 * @param {number} [options.lineHeight=1.5] - Espaçamento entre linhas
 * @param {number} [options.noiseDepth=4] - Profundidade da distorção
 * @param {number} [options.noiseFreq=1] - Frequência da distorção
 * @param {boolean} [options.debug=false] - Mostrar logs de execução
 * @returns {Promise<Buffer>} - Buffer da imagem gerada
 */
async function tahta(options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const w = options.width || 1024;
      const h = options.height || w;
      const lh = options.lineHeight || 1.5;
      const text = options.text || 'TAHTA';
      const fontFile = options.font || path.join(_font, 'Roboto-Black.ttf');
      const bgImg = options.backgroundImage || path.join(aesthetic, pickRandom(fs.readdirSync(aesthetic)));
      const fontSize = options.fontSize || (320 / 2048 * w);
      const color = options.color || 'white';
      const bgColor = options.bgColor || 'black';
      const noiseDepth = options.noiseDepth || 4;
      const noiseFreq = options.noiseFreq || 1;

      const s = `${w}x${h}`;
      const xF = `(${noise('X', noiseDepth, w, noiseFreq)}+${noise('Y', noiseDepth / 2, h, noiseFreq)})/2+128`;
      const yF = `((${pickRandom(['', '-'])}${45 * w / 2048}*${pickRandom(['sin', 'cos'])}(X/${w}*4*PI))+${noise('X', noiseDepth + 1, w, 0.8)}+${noise('Y', noiseDepth / 2, h, noiseFreq)})/1.7+128`;

      const layers = [
        `[v:0]scale=${s},format=rgb24[im]`,
        textArgs('HARTA', bgColor, color, fontSize, fontFile, '(w-text_w)/2', `(h-text_h)/2-(text_h*${lh})`) + '[top]',
        textArgs('TAHTA', bgColor, color, fontSize, fontFile, '(w-text_w)/2', `(h-text_h)/2`) + '[mid]',
        textArgs(text, bgColor, color, fontSize, fontFile, '(w-text_w)/2', `(h-text_h)/2+(text_h*${lh})`) + '[bot]',
        '[top][mid]blend=all_mode=addition[con]',
        '[con][bot]blend=all_mode=addition[txt]',
        `nullsrc=s=${s},geq='r=${xF}:g=${xF}:b=${xF}'[dx]`,
        `nullsrc=s=${s},geq='r=${yF}:g=${yF}:b=${yF}'[dy]`,
        '[txt][dx][dy]displace[wa]',
        '[im][wa]blend=all_mode=multiply:all_opacity=1'
      ];

      const outputFile = path.join(tmp, `${Date.now()}_tahta.png`);
      const args = [
        '-y',
        '-i', bgImg,
        '-filter_complex', layers.join(';'),
        '-frames:v', '1',
        outputFile
      ];

      if (options.debug) console.log('FFMPEG args:', args.join(' '));

      const ffmpeg = spawn('ffmpeg', args);

      ffmpeg.on('error', reject);
      ffmpeg.on('close', () => {
        try {
          const buffer = fs.readFileSync(outputFile);
          fs.unlinkSync(outputFile);
          resolve(buffer);
        } catch (err) {
          reject(err);
        }
      });

    } catch (err) {
      reject(err);
    }
  });
}

// --- Funções auxiliares ---
function noise(_var, depth = 4, s = 1024, freq = 1) {
  return Array.from({ length: depth }, (_, i) =>
    formula(_var, freq * rand(40, 80) * (s / 2048) / s * ((i + 1) / 5), rand(-Math.PI, Math.PI), (i + 1) / depth * 8, 0)
  ).join('+');
}

function formula(_var, freq, offset, amp, add) {
  return `(${add.toFixed(3)}+${amp.toFixed(4)}*sin(${offset.toFixed(6)}+2*PI*${_var}*${freq.toFixed(6)}))`;
}

function textArgs(text, bgColor, color, size, fontfile, x = '200', y = '200') {
  return `color=${bgColor}:s=1024x1024,drawtext=text='${text.replace(/[\\]/g, '\\$&')}':fontfile='${fontfile.replace(/[\\]/g, '\\$&')}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`;
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function rand(min, max, q = 0.001) {
  return Math.floor((Math.random() * (max - min)) / q) * q;
}

module.exports = { tahta };
