export const RETAILERS = {
  WALMART: 'walmart',
  TARGET: 'target',
  POKEMON_CENTER: 'pokemon-center',
  BEST_BUY: 'bestbuy',
  COSTCO: 'costco',
  GAMESTOP: 'gamestop',
  SAMS_CLUB: 'samsclub'
}

export const IPC = {
  TASKS_GET: 'tasks:get',
  TASKS_CREATE: 'tasks:create',
  TASKS_UPDATE: 'tasks:update',
  TASKS_DELETE: 'tasks:delete',
  TASKS_START: 'tasks:start',
  TASKS_STOP: 'tasks:stop',
  TASKS_TEST: 'tasks:test',
  TASKS_READINESS: 'tasks:readiness',
  CATALOG_GET: 'catalog:get',
  CATALOG_ADD_URL: 'catalog:add-url',
  CATALOG_DELETE: 'catalog:delete',
  PROXIES_DOWNLOAD: 'proxies:download',
  PROXIES_TEST: 'proxies:test',
  ACCOUNTS_GET: 'accounts:get',
  ACCOUNTS_CREATE: 'accounts:create',
  ACCOUNTS_UPDATE: 'accounts:update',
  ACCOUNTS_DELETE: 'accounts:delete',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  FEED_EVENT: 'feed:event',
  TASK_STATUS: 'task:status',
  ACCOUNT_STATUS: 'account:status',
  ACCOUNTS_REGISTER: 'accounts:register',
  ACCOUNTS_SET_STATUS: 'accounts:set-status',
  ACCOUNTS_OPEN_SESSION: 'accounts:open-session',
  ACCOUNTS_CHECK_SESSION: 'accounts:check-session',
  ACCOUNTS_AUTO_LOGIN: 'accounts:auto-login'
}

export const RETAILER_BUY_LIMITS = {
  [RETAILERS.TARGET]: 2,
  [RETAILERS.WALMART]: 5
}

export const DROP_TYPES = {
  IN_STOCK: 'in_stock',
  QUEUE_OPEN: 'queue_open',
  PRICE_DROP: 'price_drop'
}
