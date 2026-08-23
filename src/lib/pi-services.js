export const DEVICE_SERVICES = {
  'pokebot-worker': [
    'api-monitor',
    'target-stock-observer-go',
    'pokemon-center-queue',
    'samsclub-monitor',
    'target-catalog-bootstrap',
    'walmart-link-finder',
    'walmart-monitor',
    'target-stock-observer-go-test',
    'pokealert-discord-bot'
  ],
  pokebot2: ['pi-health-reporter']
}

export const SERVICE_LABELS = {
  'api-monitor': 'Target monitor (Python, legacy)',
  'target-stock-observer-go': 'Target Stock Monitor (Go)',
  'pokemon-center-queue': 'Pokémon Center queue detector',
  'samsclub-monitor': "Sam's Club monitor",
  'target-catalog-bootstrap': 'Target Catalog Refresh',
  'walmart-link-finder': 'Walmart Link Finder',
  'walmart-monitor': 'Walmart monitor',
  'target-stock-observer-go-test': 'Target monitor (Go, shadow)',
  'pokealert-discord-bot': 'Discord bot',
  'pi-health-reporter': 'Health reporter'
}

export const SERVICE_META = {
  'api-monitor': {
    label: SERVICE_LABELS['api-monitor'],
    group: 'legacy',
    description: 'Disabled Python monitor retained for rollback.',
    production: false,
    supportsLogs: false,
  },
  'target-stock-observer-go': {
    label: SERVICE_LABELS['target-stock-observer-go'],
    group: 'production',
    description: 'Proxy-only Target stock monitor used in production.',
    production: true,
    supportsLogs: true,
  },
  'pokemon-center-queue': {
    label: SERVICE_LABELS['pokemon-center-queue'],
    group: 'production',
    description: 'Independent queue detector; Electron checkout remains separate.',
    production: true,
    supportsLogs: false,
  },
  'samsclub-monitor': {
    label: SERVICE_LABELS['samsclub-monitor'],
    group: 'production',
    description: 'Sam\'s Club stock monitor.',
    production: true,
    supportsLogs: false,
  },
  'walmart-monitor': {
    label: SERVICE_LABELS['walmart-monitor'],
    group: 'production',
    description: 'Walmart stock monitor.',
    production: true,
    supportsLogs: false,
  },
  'target-catalog-bootstrap': {
    label: SERVICE_LABELS['target-catalog-bootstrap'],
    group: 'tools',
    description: 'One-shot Target catalog refresh.',
    production: false,
    supportsLogs: false,
  },
  'walmart-link-finder': {
    label: SERVICE_LABELS['walmart-link-finder'],
    group: 'tools',
    description: 'One-shot Walmart match discovery.',
    production: false,
    supportsLogs: false,
  },
  'target-stock-observer-go-test': {
    label: SERVICE_LABELS['target-stock-observer-go-test'],
    group: 'experimental',
    description: 'Shadow-only Go observer; no alerts or writes.',
    production: false,
    supportsLogs: false,
  },
  'pokealert-discord-bot': {
    label: SERVICE_LABELS['pokealert-discord-bot'],
    group: 'production',
    description: 'Discord notification service.',
    production: true,
    supportsLogs: false,
  },
  'pi-health-reporter': {
    label: SERVICE_LABELS['pi-health-reporter'],
    group: 'production',
    description: 'Raspberry Pi telemetry publisher.',
    production: true,
    supportsLogs: false,
  },
}

export function serviceDisplayName(service) {
  return SERVICE_META[service]?.label || SERVICE_LABELS[service] || service
}

export function serviceGroup(service) {
  return SERVICE_META[service]?.group || 'other'
}

export const ONE_SHOT_SERVICES = ['target-catalog-bootstrap', 'walmart-link-finder']

export const ALLOWED_SERVICES = [
  'api-monitor',
  'target-stock-observer-go',
  'pokemon-center-queue',
  'samsclub-monitor',
  'target-catalog-bootstrap',
  'walmart-link-finder',
  'walmart-monitor',
  'target-stock-observer-go-test',
  'pokealert-discord-bot',
  'pi-health-reporter'
]
