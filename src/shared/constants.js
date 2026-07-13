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
  MONITORS_LIST: 'monitors:list',
  MONITORS_SAVE: 'monitors:save',
  MONITORS_DELETE: 'monitors:delete',
  CATALOG_GET: 'catalog:get',
  CATALOG_ADD_URL: 'catalog:add-url',
  CATALOG_DELETE: 'catalog:delete',
  CATALOG_FIND_WALMART_MATCH: 'catalog:find-walmart-match',
  CATALOG_SAVE_WALMART_MATCH: 'catalog:save-walmart-match',
  CATALOG_LIST_WALMART_MATCHES: 'catalog:list-walmart-matches',
  PROXIES_DOWNLOAD: 'proxies:download',
  PROXIES_TEST: 'proxies:test',
  ACCOUNTS_GET: 'accounts:get',
  ACCOUNTS_CREATE: 'accounts:create',
  ACCOUNTS_UPDATE: 'accounts:update',
  ACCOUNTS_DELETE: 'accounts:delete',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  MONITOR_SET_MODE: 'monitor:set-mode',
  AUTH_SIGN_IN: 'auth:sign-in',
  AUTH_SIGN_UP: 'auth:sign-up',
  AUTH_SIGN_OUT: 'auth:sign-out',
  AUTH_GET_STATUS: 'auth:get-status',
  AUTH_STATE_CHANGED: 'auth:state-changed',
  SUPABASE_CATALOG_LIST: 'catalog:supabase-list',
  FEED_EVENT: 'feed:event',
  TASK_STATUS: 'task:status',
  QUEUE_JOIN: 'queue:join',
  QUEUE_STOP: 'queue:stop',
  QUEUE_PROGRESS: 'queue:progress',
  ACCOUNT_STATUS: 'account:status',
  ACCOUNTS_REGISTER: 'accounts:register',
  ACCOUNTS_SET_STATUS: 'accounts:set-status',
  ACCOUNTS_OPEN_SESSION: 'accounts:open-session',
  ACCOUNTS_CHECK_SESSION: 'accounts:check-session',
  ACCOUNTS_AUTO_LOGIN: 'accounts:auto-login',
  ACCOUNTS_WARMUP: 'accounts:warmup',
  PROGRESS_STREAM_START: 'progress:stream:start',
  PROGRESS_STREAM_STEP: 'progress:stream:step',
  PROGRESS_STREAM_UPDATE: 'progress:stream:update',
  PROGRESS_STREAM_SUCCESS: 'progress:stream:success',
  PROGRESS_STREAM_ERROR: 'progress:stream:error',
  CONFIG_EXPORT: 'config:export',
  CONFIG_IMPORT: 'config:import',
  CONFIG_CREATE_EXAMPLE: 'config:create-example',
  PAYMENTS_GET: 'payments:get',
  PAYMENTS_CREATE: 'payments:create',
  PAYMENTS_UPDATE: 'payments:update',
  PAYMENTS_DELETE: 'payments:delete',
  SHIPPING_GET: 'shipping:get',
  SHIPPING_CREATE: 'shipping:create',
  SHIPPING_UPDATE: 'shipping:update',
  SHIPPING_DELETE: 'shipping:delete',
  SHIPPING_SET_DEFAULT: 'shipping:set-default'
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

export const TASK_MODES = {
  AUTO_CHECKOUT: 'auto-checkout',
  ALERT_ONLY: 'alert-only',
  TEST_CHECKOUT: 'test-checkout'
}

export const TASK_MODE_LABELS = {
  [TASK_MODES.AUTO_CHECKOUT]: 'Auto-Checkout (Buy on restock)',
  [TASK_MODES.ALERT_ONLY]: 'Alert Only (Notify, no purchase)',
  [TASK_MODES.TEST_CHECKOUT]: 'Test Mode (Stop before order)'
}
