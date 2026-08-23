export function filterLogs(logs, { query = '', service = '', level = '' } = {}) {
  const normalizedQuery = String(query).trim().toLowerCase()
  const normalizedService = String(service).trim().toLowerCase()
  const normalizedLevel = String(level).trim().toLowerCase()

  return (Array.isArray(logs) ? logs : []).filter((row) => {
    const haystack = [row.message, row.service, row.worker_name].map((value) => String(value || '').toLowerCase()).join(' ')
    return (!normalizedQuery || haystack.includes(normalizedQuery)) &&
      (!normalizedService || String(row.service || '').toLowerCase() === normalizedService) &&
      (!normalizedLevel || String(row.level || '').toLowerCase() === normalizedLevel)
  })
}
