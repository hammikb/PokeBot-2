export const APP_TIME_ZONE = 'America/Los_Angeles'

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short'
})

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short'
})

function parseTimestamp(value) {
  if (value == null || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatAppTime(value, fallback = 'Unknown time') {
  const date = parseTimestamp(value)
  return date ? timeFormatter.format(date) : fallback
}

export function formatAppDateTime(value, fallback = 'Unknown time') {
  const date = parseTimestamp(value)
  return date ? dateTimeFormatter.format(date) : fallback
}
