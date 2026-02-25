const axios = require('axios') // V4.x
const chalk = require('chalk')
const { promisify } = require('util')
const sleep = promisify(setTimeout)

const API_URL = 'https://freefirejornal.com/free-fire-likes-ganhe-ate-100-likes-com-esta-ferramenta'
const HEADERS = {
'Content-Type': 'application/json',
'Origin': 'https://freefirejornal.com',
'Referer': 'https://freefirejornal.com/free-fire-likes-ganhe-ate-100-likes-com-esta-ferramenta/',
'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

class FreeFireLikesBooster {
constructor(playerId, region = 0, requests = 1, delay = 1000) {
this.playerId = playerId
this.region = region
this.requests = requests
this.delay = delay
this.successCount = 0
this.errorCount = 0
}
async sendLikeRequest() {
try {
const payload = {
id: this.playerId,
regiao: this.region.toString()
}
const response = await axios.post(API_URL, payload, { headers: HEADERS })
if (response.status === 200) {
this.successCount++
console.log(chalk.green(`✓ Likes adicionados  - Total: ${this.successCount * 100}`))
return true
}
} catch (error) {
this.errorCount++
console.error(chalk.red(`✗ Erro na requisição: ${error.message}`))
return false
}
}
async start() {
console.log(chalk.yellow.bold('\nIniciando processo de ganhar likes...\n'))
for (let i = 0; i < this.requests; i++) {
await this.sendLikeRequest()
if (i < this.requests - 1) {
await sleep(this.delay)
}
}
this.showSummary()
}
showSummary() {
console.log(chalk.cyan.bold('\nResumo do processo:'))
console.log(chalk.cyan(`▶ Total de solicitações: ${this.requests}`))
console.log(chalk.green(`▶ Likes adicionados com sucesso: ${this.successCount * 100}`))
console.log(chalk.red(`▶ Erros durante o processo: ${this.errorCount}`))
}
}

// Uso
const booster = new FreeFireLikesBooster(
'371412786', // Seu Player ID
0, // Região (0=Brasil)
1, // Número de solicitações
1500 // Delay entre requisições (ms)
)

booster.start()

module.exports = { FreeFireLikesBooster }