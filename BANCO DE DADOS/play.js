const { search, ytmp3, ytmp4, ytdlv2, channel, transcript } = require('@vreden/youtube_scraper');

//FUNÇÃOZINHA DO PLAY 😼
async function youtubeadl2(url) {
try {
const youtu = await ytmp3(url);
return youtu;
} catch (e) {
console.log(e)
}
}

async function youtubeVideoDl(url) {
try {
const youtu = await ytmp4(url);
return youtu;
} catch (e) {
console.log(e)
return "deu erro";
}
}

async function youtubeSearch(query) {
try {
const youtu = await search(query);
return youtu;
} catch (e) {
console.log(e)
return "deu erro";
}
}

async function youtubeYtdlv2(url) {
try {
const youtu = await ytdlv2(url);
return youtu;
} catch (e) {
console.log(e)
return "deu erro";
}
}

async function youtubeChannel(channel3) {
try {
const youtu = await channel(channel3);
return youtu;
} catch (e) {
console.log(e)
return "deu erro";
}
}

async function youtubeTranscript(url) {
try {
const youtu = await transcript(url);
return youtu;
} catch (e) {
console.log(e)
return "deu erro";
}
}

module.exports = { youtubeadl2, youtubeVideoDl, youtubeSearch, youtubeYtdlv2, youtubeChannel, youtubeTranscript }