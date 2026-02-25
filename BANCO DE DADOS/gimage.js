const axios = require('axios');
const cheerio = require('cheerio');
const queryString = require('querystring');
const flatten = require('lodash.flatten');

const baseURL = 'https://www.google.com/search?';
const imageFileExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg'];

async function gis(searchTerm, opts = {}) {
  try {
    let filterOutDomains = ['gstatic.com'];
    if (opts.filterOutDomains) filterOutDomains = filterOutDomains.concat(opts.filterOutDomains);

    const url =
      baseURL +
      queryString.stringify({
        tbm: 'isch',
        q: searchTerm
      }) +
      (filterOutDomains.length ? ' ' + filterOutDomains.map(d => '-site:' + d).join(' ') : '');

    const { data } = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
      }
    });

    const $ = cheerio.load(data);
    const scripts = $('script');
    let imageScripts = [];

    scripts.each((i, script) => {
      if (script.children[0] && containsAnyImageFileExtension(script.children[0].data)) {
        imageScripts.push(script.children[0].data);
      }
    });

    const images = flatten(imageScripts.map(collectImageRefs(filterOutDomains)));
    return images;

  } catch (err) {
    console.error("GImage Error:", err.message);
    return [];
  }
}

function collectImageRefs(filterOutDomains) {
  return function (content) {
    const refs = [];
    const re = /\["(http.+?)",(\d+),(\d+)\]/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      const ref = { url: match[1], width: +match[3], height: +match[2] };
      if (domainIsOK(ref.url, filterOutDomains)) refs.push(ref);
    }
    return refs;
  };
}

function domainIsOK(url, filterOutDomains) {
  return filterOutDomains.every(domain => !url.includes(domain));
}

function containsAnyImageFileExtension(s) {
  if (!s) return false;
  s = s.toLowerCase();
  return imageFileExtensions.some(ext => s.includes(ext));
}

// **Exportando corretamente a função**
module.exports = { gis };
