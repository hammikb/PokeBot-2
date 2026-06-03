const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' '
}

export function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      const n = entity.toLowerCase()
      if (n.startsWith('#x')) return String.fromCodePoint(parseInt(n.slice(2), 16))
      if (n.startsWith('#')) return String.fromCodePoint(parseInt(n.slice(1), 10))
      return ENTITIES[n] || match
    })
    .replace(/\s+/g, ' ')
    .trim()
}

export function stripHtml(value) {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
}
