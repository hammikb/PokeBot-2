# Graph Report - .  (2026-08-17)

## Corpus Check
- 307 files · ~222,843 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2431 nodes · 4755 edges · 160 communities (123 shown, 37 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 142 edges (avg confidence: 0.65)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Options Polar Extension
- Scripts Pokemon
- Automation Flows
- Automation Browserpool
- Telemetry Checkouttelemetry
- Products Productcatalog
- Target Reliability
- Tasks Dropeventledger
- Popup Polar Extension
- Polar Extension Background
- Scripts Target
- Design Checkout
- Deploy Target
- Polar Extension Manifest
- Automation Queuejoiner
- Ipc Supabase
- Monitor Supabasemonitorsource
- Package Json
- Polar Extension Background
- Package Json
- Guides Target
- Polar Extension Common
- Utils Retrymanager
- Monitor Retailers
- Scripts Scrapling
- Automation Flows
- Experimental Debugmanager
- Proxies Proxyhealthmonitor
- Automation Api
- Utils Logger
- Polar Extension Common
- Automation Flows
- Package Json
- Automation Flows
- Monitor Retailers
- Deploy Health
- Automation Nativeinputbridge
- Polar Extension Background
- Health Monitorhealth
- Monitor Retailers
- Renderer Pages
- Tasks Ordersubmissiongate
- Automation Flows
- Tasks Taskmanager
- Renderer Pages
- Tasks Taskmanager
- Renderer Pages
- Scripts Walmart
- Automation Flows
- Notify Notificationengine
- Supabase Supabaseclient
- Renderer Pages
- Polar Extension Background
- Automation Flows
- Index Lifecycle
- Tasks Taskreadiness
- Polar Extension Background
- Patch Pokealert
- Accounts Accountmanager
- Automation Flows
- Automation Pokemoncenterqueuejoiner
- Tasks Taskmanager
- Monitor Monitorbrowsercontext
- Polar Extension Background
- Tasks Taskmanager
- Crypto Supabase
- Monitor Pokemonfinder
- Supabase Authsessionmanager
- Guides Restock
- Patch Target
- Automation Api
- Security Vaultkeymanager
- Experimental Restockpredictor
- Shipping Shippingmanager
- Utils Progressstreamer
- Polar Extension Common
- Scripts Monitor
- Automation Profilewarmup
- Experimental Queueoptimizer
- Payments Paymentmanager
- Tasks Retailercircuitbreaker
- Renderer Pages
- Polar Extension Background
- Renderer Components
- Automation Cookiemanager
- Experimental Ratelimiter
- Monitor Retailers
- Preload Index
- Roadmaps Improvements
- Target Electron
- Scripts Check
- Automation Checkoutdiagnostics
- Monitor Monitorengine
- Monitor Retailers
- Monitor Retailers
- Monitor Retailers
- Package Json
- Options Polar Extension
- Scripts Drop
- Monitor Retailers
- Proxies Proxyimport
- Thumbnails Thumbnailcache
- Automation Flows
- Control Plane
- Ref Counted
- Resources Icon
- Security Renderersecurity
- Renderer Pages
- Scripts Run
- Health Startupdiagnostics
- Tasks Taskstate
- Account Registration
- Supabase Monitor
- Electron App
- Target Polar
- Checkout Account
- Electron Builder
- Polar Extension Icons
- Polar Extension Icons
- Scripts Diagnostics
- Scripts Diagnostics
- Renderer Index
- Renderer Assets
- Renderer Components
- Roadmaps Complete
- Roadmaps Github
- Polar Extension Icons
- Scripts Clean
- Scripts Optional
- Scripts Validate
- Renderer Assets
- Guides Scrapling
- Retailer Controls
- Pokemon Center
- Package Json
- Package Json
- Package Json
- Package Json
- Polar Extension Icons
- Scripts Diagnostics
- Scripts Maintenance
- Scripts Verify
- Experimental Readme
- Supabase Readme
- Renderer Monitorbuilder
- Prettierrc Yaml
- Deploy Health
- Deploy Target

## God Nodes (most connected - your core abstractions)
1. `TaskManager` - 58 edges
2. `createModuleLogger()` - 40 edges
3. `waitForCaptchaIfNeeded()` - 32 edges
4. `registerIpcHandlers()` - 30 edges
5. `BrowserPool` - 27 edges
6. `SupabaseMonitorSource` - 27 edges
7. `useAppStore` - 27 edges
8. `DebugManager` - 26 edges
9. `AtomicAlertState` - 25 edges
10. `runTargetFlow()` - 25 edges

## Surprising Connections (you probably didn't know these)
- `Sanitized Checkout Analytics Domain` --semantically_similar_to--> `CheckoutTelemetry`  [INFERRED] [semantically similar]
  src/main/README.md → docs/superpowers/specs/2026-08-15-checkout-observability-design.md
- `Persistent Patchright Chromium Detector` --semantically_similar_to--> `Pokemon Center Detector Operations`  [INFERRED] [semantically similar]
  docs/superpowers/specs/2026-08-17-pokemon-center-queue-monitor-design.md → scripts/README.md
- `Pokemon Center Detector Operations` --semantically_similar_to--> `Proxy Quarantine and Rotation`  [INFERRED] [semantically similar]
  scripts/README.md → docs/superpowers/specs/2026-08-17-pokemon-center-queue-monitor-design.md
- `attemptTargetQueueBypass()` --indirect_call--> `url()`  [INFERRED]
  src/main/automation/targetQueueBypass.js → tests/main/automation/flows/submission-safety.test.js
- `register()` --calls--> `registerIpcHandlers()`  [EXTRACTED]
  tests/main/ipc.monitorHealth.test.js → src/main/ipc.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Walmart Profile Trust Strategy** — docs_guides_multi_account_setup_separate_browser_profiles, docs_guides_warmup_workaround_trusted_profile_history, docs_reference_walmart_automation_notes_real_profile_and_human_delays [INFERRED 0.95]
- **API Plus Browser Checkout Pattern** — docs_guides_walmart_fast_checkout_hybrid_api_browser_checkout, docs_reference_debug_api_browser_context_api_call, docs_roadmaps_future_improvements_api_based_cart_operations [INFERRED 0.85]
- **Reliability Verification Practices** — docs_guides_target_checkout_trace_and_screenshot_evidence, docs_guides_testing_guide_testing_pokebot_2, docs_operations_2026_08_11_target_reliability_rollout_target_reliability_rollout [INFERRED 0.85]
- **Checkout Account Contention Visibility** — docs_superpowers_specs_2026_08_15_checkout_account_ownership_design_checkout_ownership_lease, docs_superpowers_specs_2026_08_15_checkout_observability_design_account_lease_events, docs_superpowers_specs_2026_08_15_checkout_observability_design_checkout_analytics_ui [INFERRED 0.95]
- **Pokemon Center Queue Detection Contract** — docs_superpowers_specs_2026_08_17_pokemon_center_queue_monitor_design_four_state_classifier, docs_superpowers_specs_2026_08_17_pokemon_center_queue_monitor_design_queue_open_contract, tests_fixtures_retailers_pokemon_center_queue_virtual_queue_page [INFERRED 0.85]
- **Polar Extension Visual Identity** — polar_extension_icons_icon128_polar_bear_mascot, polar_extension_icons_icon128_circular_tech_badge, polar_extension_icons_icon128_icy_cyberpunk_palette [INFERRED 0.85]
- **Atomic Visual Motif** — resources_icon_atom_symbol, resources_icon_orbital_paths, resources_icon_electron_nodes [EXTRACTED 1.00]

## Communities (160 total, 37 thin omitted)

### Community 0 - "Options Polar Extension"
Cohesion: 0.05
Nodes (107): _0x10199e(), _0x11c99e(), _0x12feaa(), _0x13994a(), _0x143b22(), _0x1590a4(), _0x17c959(), _0x192506() (+99 more)

### Community 1 - "Scripts Pokemon"
Cohesion: 0.06
Nodes (39): main(), check(), main(), classify_observation(), Observation, ProxyHealthPool, QueueTransitionTracker, Pure state logic for the Pokemon Center queue detector. (+31 more)

### Community 2 - "Automation Flows"
Cohesion: 0.06
Nodes (54): validateTargetSession(), humanDelay(), browserAddToCart(), claimTargetAction(), CONFIRMATION_SELECTORS, confirmRequestedTargetCartItem(), dismissTargetCheckoutDialog(), enableTargetCheckoutLiteMode() (+46 more)

### Community 3 - "Automation Browserpool"
Cohesion: 0.06
Nodes (36): CHALLENGE_MARKERS, FINGERPRINT_DIMENSIONS, hasAbckCookie(), log, PROTECTED_PROBE_ENDPOINTS, regenerateTargetSensorData(), waitForAbckCookie(), BrowserPool (+28 more)

### Community 4 - "Telemetry Checkouttelemetry"
Cohesion: 0.06
Nodes (50): BOOLEAN_FIELDS, ENUM_FIELDS, EVENT_TYPES, INTEGER_RANGES, LEASE_STATES, parseCheckoutEventMetadata(), REQUEST_TYPES, RESPONSE_KINDS (+42 more)

### Community 5 - "Products Productcatalog"
Cohesion: 0.08
Nodes (48): decodeHtmlEntities(), ENTITIES, stripHtml(), addCatalogItemFromUrl(), blockedUrlToCatalogItem(), detectRetailer(), extractItemIdFromUrl(), extractRetailerItemId() (+40 more)

### Community 6 - "Target Reliability"
Cohesion: 0.08
Nodes (29): Any, date, datetime, PathLike, AtomicAlertState, batch_signatures(), _bounds(), _clock() (+21 more)

### Community 7 - "Tasks Dropeventledger"
Cohesion: 0.06
Nodes (28): applyDefaults(), buildJsonWherePredicate(), createSqliteDb(), firstLine(), getDb(), getJsonDbPath(), initDb(), isJsonDbFile() (+20 more)

### Community 8 - "Popup Polar Extension"
Cohesion: 0.12
Nodes (44): _0x129830(), _0x174a05(), _0x181644(), _0x181b16(), _0x191227(), _0x1990b9(), _0x258589(), _0x262109() (+36 more)

### Community 9 - "Polar Extension Background"
Cohesion: 0.05
Nodes (41): _0x117b19, _0x13ad70, _0x145f4c, _0x14d943, _0x19ec(), _0x1b76b0(), _0x200777, _0x20bb78 (+33 more)

### Community 10 - "Scripts Target"
Cohesion: 0.12
Nodes (38): changed_to_available(), current_poll_schedule(), extract_tcin(), fetch_observation(), find_shipping_options(), inventory_changed(), is_available(), is_fast_poll_window() (+30 more)

### Community 11 - "Design Checkout"
Cohesion: 0.06
Nodes (37): Account Busy State, Checkout Account Ownership Design, Checkout Ownership Lease, Fail-safe Lease Release, Pinned Browser Context, Account Checkout Lease Events, Checkout Analytics UI, Checkout Observability Design (+29 more)

### Community 12 - "Deploy Target"
Cohesion: 0.13
Nodes (32): env(), envBool(), envFloat(), envInt(), extractTCIN(), fetchObservation(), fetchWithFailover(), findShippingOptions() (+24 more)

### Community 13 - "Polar Extension Manifest"
Cohesion: 0.06
Nodes (33): action, default_icon, default_popup, background, service_worker, type, content_security_policy, extension_pages (+25 more)

### Community 14 - "Automation Queuejoiner"
Cohesion: 0.11
Nodes (10): log, qpdataToken(), queueCycleIdFor(), QueueJoiner, toSafeQueueStatus(), extractQpdataFromText(), isQueueActive(), parseQp() (+2 more)

### Community 15 - "Ipc Supabase"
Cohesion: 0.09
Nodes (30): accountArgs, accountHasActiveTask(), authArgs, detectRetailer(), emitCatalogLookupFallback(), emptyArgs, idObjectArgs, IPC_ARG_SCHEMAS (+22 more)

### Community 16 - "Monitor Supabasemonitorsource"
Cohesion: 0.12
Nodes (7): ACTIONABLE_DROP_TYPES, compareDropRows(), normalizeObservedAt(), stableEventId(), SupabaseMonitorSource, SEED, TARGET_PRODUCT

### Community 17 - "Package Json"
Cohesion: 0.06
Nodes (31): electron-builder, @electron-toolkit/eslint-config, electron-vite, eslint, eslint-plugin-react, eslint-plugin-react-hooks, eslint-plugin-react-refresh, devDependencies (+23 more)

### Community 18 - "Polar Extension Background"
Cohesion: 0.12
Nodes (30): _0x150a8b(), _0x158e2b(), _0x17a81a(), _0x1b1b5f(), _0x1b1f20(), _0x1c7640(), _0x1cadf7(), _0x1d3169() (+22 more)

### Community 19 - "Package Json"
Cohesion: 0.07
Nodes (29): axios, better-sqlite3, cheerio, cloakbrowser, @electron-toolkit/preload, @electron-toolkit/utils, @ghostery/adblocker-playwright, mmdb-lib (+21 more)

### Community 20 - "Guides Target"
Cohesion: 0.07
Nodes (28): @striderlabs/mcp-walmart, Walmart MCP Server Setup, Target Auto-Checkout, Test Checkout Mode, Trace and Screenshot Evidence, Live Progress Streaming, Proxy Health Monitoring, Smart Retry System (+20 more)

### Community 21 - "Polar Extension Common"
Cohesion: 0.11
Nodes (22): _0x2ae7(), _0x2fe2f8, _0x405b(), createButtonWatcher(), createElementWatcher(), fillFieldBySelectors(), findElementWithSelectors(), _0x28d9() (+14 more)

### Community 22 - "Utils Retrymanager"
Cohesion: 0.11
Nodes (11): defaultRetryManager, isNetworkError(), isTimeoutError(), log, RetryManager, sleep(), smartRetry, withRetry() (+3 more)

### Community 23 - "Monitor Retailers"
Cohesion: 0.11
Nodes (4): isGuppyInStock(), TargetPoller, MOCK_IN_STOCK, MOCK_OUT

### Community 24 - "Scripts Scrapling"
Cohesion: 0.19
Nodes (25): all_text(), attr(), clean_title(), collapse_text(), detect_retailer(), emit_error(), find_next_product(), find_product_json() (+17 more)

### Community 25 - "Automation Flows"
Cohesion: 0.20
Nodes (24): advanceCheckout(), cartCountFromText(), classifySamsPageText(), ensureSamsSignedIn(), extractSamsItemId(), findExactCartItem(), isSamsCartAcknowledgementUrl(), openSamsCheckout() (+16 more)

### Community 27 - "Proxies Proxyhealthmonitor"
Cohesion: 0.16
Nodes (6): log, ProxyHealthMonitor, proxyToPlaywright(), RETAILER_TEST_URLS, testProxy(), testRetailer()

### Community 28 - "Automation Api"
Cohesion: 0.16
Nodes (11): fullApiCheckout(), getCheckoutState(), hybridTargetCheckout(), log, pageFetch(), placeOrder(), setFulfillment(), setPayment() (+3 more)

### Community 29 - "Utils Logger"
Cohesion: 0.12
Nodes (7): log, log, log, log, createModuleLogger(), Logger, log

### Community 30 - "Polar Extension Common"
Cohesion: 0.10
Nodes (3): _0x30fc(), _0x5cf0(), CheckoutBase

### Community 31 - "Automation Flows"
Cohesion: 0.14
Nodes (11): CAPTCHA_SELECTORS, detectCaptchaConfig(), isCaptchaPresent(), log, solveCaptchaWithCapsolver(), waitForCaptchaIfNeeded(), runTargetRegistration(), waitForEnabled() (+3 more)

### Community 32 - "Package Json"
Cohesion: 0.10
Nodes (21): scripts, build, build:linux, build:mac, build:unpack, build:win, check:structure, clean (+13 more)

### Community 33 - "Automation Flows"
Cohesion: 0.18
Nodes (11): captureSessionScreenshot(), checkTargetSession(), getAppDataDir(), runTargetAutoLogin(), enableFastNavigation(), getOrCreateTargetPage(), isBlankPage(), isClosedPage() (+3 more)

### Community 34 - "Monitor Retailers"
Cohesion: 0.18
Nodes (10): centralTimeToUtc(), extractAnnouncedSamsReleaseAt(), extractSamsItemId(), extractSamsProduct(), getSamsProductState(), isSamsBrowserTrafficGate(), log, MONTHS (+2 more)

### Community 35 - "Deploy Health"
Cohesion: 0.21
Nodes (18): collectHealth(), cpuPercent(), envInt(), floatPtr(), formatPtr(), main(), platformName(), postHealth() (+10 more)

### Community 36 - "Automation Nativeinputbridge"
Cohesion: 0.17
Nodes (3): loadNut(), log, NativeInputBridge

### Community 37 - "Polar Extension Background"
Cohesion: 0.24
Nodes (20): _0x14eafb(), _0x1d2071(), _0x1f136a(), _0x20f2e1(), _0x257dd4(), _0x34383b(), _0x398b1b(), _0x3eb523() (+12 more)

### Community 38 - "Health Monitorhealth"
Cohesion: 0.16
Nodes (12): classifyHealth(), finiteNumber(), formatAge(), HEALTHY_WORKER_STATES, MonitorHealth, nonNegativeInteger(), normalizeNotificationHealth(), normalizeRealtime() (+4 more)

### Community 39 - "Monitor Retailers"
Cohesion: 0.21
Nodes (11): createDropEvent(), log, log, log, EXPLICIT_IN_STOCK, log, STOCK_ROUTE_PATTERNS, log (+3 more)

### Community 40 - "Renderer Pages"
Cohesion: 0.17
Nodes (16): Dashboard(), desktopAlertEvidence(), formatBytes(), formatCount(), formatHeartbeatAge(), formatRate(), MONITOR_STATUS_STYLE, STATUS_COLOR (+8 more)

### Community 41 - "Tasks Ordersubmissiongate"
Cohesion: 0.14
Nodes (6): runCostcoFlow(), extractProductKey(), OrderSubmissionGate, FLOWS, log, walmartAutoQueueJobId()

### Community 42 - "Automation Flows"
Cohesion: 0.20
Nodes (18): captureAutoLoginScreenshot(), clickTargetPasswordMethod(), CONTINUE_SELECTORS, fastFill(), fillTargetCredentials(), getAppDataDir(), isPasswordFieldVisible(), keepTargetSessionSignedIn() (+10 more)

### Community 44 - "Renderer Pages"
Cohesion: 0.20
Nodes (14): CheckoutAttemptObservability(), AttemptDetails(), AttemptList(), Breakdown(), ExperimentGrid(), formatDuration(), formatPercent(), formatTimestamp() (+6 more)

### Community 45 - "Tasks Taskmanager"
Cohesion: 0.27
Nodes (3): buildMonitorIdentity(), pendingUnsubscribeIdentity(), taskProductIdentity()

### Community 46 - "Renderer Pages"
Cohesion: 0.26
Nodes (11): App(), CheckoutAnalytics(), Login(), PaymentMethods(), FIELDS, Settings(), ShippingAddresses(), invoke() (+3 more)

### Community 47 - "Scripts Walmart"
Cohesion: 0.16
Nodes (14): BLOCK_STATUSES, ensureWalmartProduct(), inspectQueueGate(), intervalMs, log, logBrowseChanges(), main(), maxQueueProbes (+6 more)

### Community 48 - "Automation Flows"
Cohesion: 0.14
Nodes (7): parseDisplayedPrice(), readRetailerCartItem(), validateCheckoutSafety(), ensureWalmartSignedIn(), extractWalmartItemId(), runWalmartFlow(), BASE

### Community 49 - "Notify Notificationengine"
Cohesion: 0.17
Nodes (6): ACTIONABLE_TYPES, createDesktopNotifier(), loadNotification(), notifierByListener, sendDesktopAlert(), NotificationEngine

### Community 50 - "Supabase Supabaseclient"
Cohesion: 0.19
Nodes (5): SUPABASE_KEY, SUPABASE_URL, getPublicClient(), SupabaseClient, { signInWithPassword, setAuth, createClient }

### Community 51 - "Renderer Pages"
Cohesion: 0.17
Nodes (13): formatMoney(), MonitorBuilder(), RETAILERS, CHECKOUT_TEST_RETAILERS, getTaskAccountCount(), makeDefaultForm(), MODE_OPTIONS, renderReadinessBar() (+5 more)

### Community 52 - "Polar Extension Background"
Cohesion: 0.19
Nodes (16): _0x1203bc(), _0x15cb16(), _0x166757(), _0x199447(), _0x22db0c(), _0x23ff6a(), _0x25611c(), _0x27b456() (+8 more)

### Community 53 - "Automation Flows"
Cohesion: 0.24
Nodes (14): ATC_AFTER_QUEUE_SELECTOR, ATC_SELECTOR, CART_CONFIRMATION_SELECTOR, CHECKOUT_READY_SELECTOR, CONTINUE_BTN_SELECTOR, CVV_SELECTOR, ORDER_CONFIRMATION_SELECTOR, ORDER_NUMBER_SELECTOR (+6 more)

### Community 54 - "Index Lifecycle"
Cohesion: 0.18
Nodes (8): createMainWindow(), getSettings(), hasSingleInstanceLock, settleShutdownOperations(), shutdownAndExit(), attachRendererRecovery(), createPokemonFinder(), log

### Community 55 - "Tasks Taskreadiness"
Cohesion: 0.23
Nodes (12): buildSingleTaskReadiness(), buildTaskReadiness(), check(), checkAccount(), checkLastTest(), CHECKOUT_FLOW_RETAILERS, checkProxy(), formatWhen() (+4 more)

### Community 56 - "Polar Extension Background"
Cohesion: 0.18
Nodes (15): _0x1a71b9(), _0x1dda50(), _0x1dea6a(), _0x1e236b(), _0x24bb3a(), _0x25cde8(), _0x283905(), _0x2cab8d() (+7 more)

### Community 57 - "Patch Pokealert"
Cohesion: 0.22
Nodes (7): main(), patch_file(), patch_source(), Path, Idempotently add validated dated Target schedules to the Pi control agent., _replace_callable(), ScheduleAgentPatcherTests

### Community 58 - "Accounts Accountmanager"
Cohesion: 0.25
Nodes (4): AccountManager, getAppPath(), normalizeProxy(), normalizeProxyPool()

### Community 59 - "Automation Flows"
Cohesion: 0.25
Nodes (11): FIELD_SELECTORS, fillCheckoutPayment(), findVisibleField(), setFieldValueWithEvents(), advancePokemonCheckout(), runPokemonCenterFlow(), signInAtCheckout(), createDisabledTrace() (+3 more)

### Community 60 - "Automation Pokemoncenterqueuejoiner"
Cohesion: 0.21
Nodes (4): classifyPokemonCenterQueueText(), log, PokemonCenterQueueJoiner, QUEUE_MARKERS

### Community 61 - "Tasks Taskmanager"
Cohesion: 0.20
Nodes (5): classifyDropReceiptResult(), hasAccountBusyResult(), hasManualCheckoutResult(), hasOutOfStockResult(), parseAccountIds()

### Community 62 - "Monitor Monitorbrowsercontext"
Cohesion: 0.18
Nodes (5): ADBLOCKER_ALLOWLIST, getBlocker(), log, MonitorBrowserContext, IMPORTANT: Retailer API domains are allowlisted so the adblocker never

### Community 63 - "Polar Extension Background"
Cohesion: 0.18
Nodes (14): _0x1e128a(), _0x2a7b61(), _0x2fcc35(), _0x36117c(), _0x3e3122(), _0x48d29c(), _0x4b2d9c(), _0x4fdcac() (+6 more)

### Community 64 - "Tasks Taskmanager"
Cohesion: 0.23
Nodes (3): isRetryableCheckoutError(), isRetryableCheckoutResult(), shouldPreserveTargetCheckout()

### Community 65 - "Crypto Supabase"
Cohesion: 0.31
Nodes (4): decrypt(), deriveKey(), encrypt(), KEY

### Community 68 - "Guides Restock"
Cohesion: 0.17
Nodes (12): Multi-Account Walmart Setup, Parallel Account Tasks, Separate Browser Profiles, Monitoring Flow, Parallel Checkout, Restock Monitoring and Auto-Checkout, Smart Restock Detection, Real Chrome Warmup Workaround (+4 more)

### Community 69 - "Patch Target"
Cohesion: 0.27
Nodes (8): main(), patch_file(), patch_source(), Path, Idempotently add durable Target delivery to the production Pi monitor., _replace_callable(), _replace_once(), TargetMonitorPatcherTests

### Community 71 - "Security Vaultkeymanager"
Cohesion: 0.30
Nodes (10): deriveKeyLegacy(), collectEncryptedValues(), initializeVaultKey(), migrateLegacySecrets(), readProtectedKey(), secret(), setMigrationVersion(), writeProtectedKey() (+2 more)

### Community 75 - "Polar Extension Common"
Cohesion: 0.36
Nodes (10): _0x109860, _0x5b7d(), _0x91f0(), deleteProfile(), getFromStorage(), getProfiles(), getSiteSettings(), saveProfile() (+2 more)

### Community 76 - "Scripts Monitor"
Cohesion: 0.25
Nodes (10): checkProduct(), ONCE, pollWalmartItem(), PRODUCTS, pushDrop(), runLoop(), runOnce(), stateMap (+2 more)

### Community 77 - "Automation Profilewarmup"
Cohesion: 0.25
Nodes (6): delay(), getSessionPreparationUrls(), log, ProfileWarmup, RETAILER_SESSION_PAGES, url()

### Community 78 - "Experimental Queueoptimizer"
Cohesion: 0.25
Nodes (3): defaultQueueOptimizer, log, QueueOptimizer

### Community 81 - "Renderer Pages"
Cohesion: 0.29
Nodes (9): Accounts(), getProxyCounts(), makeAccountName(), makeEmptyForm(), maskProxy(), parseShipping(), PAYMENT_ACCOUNT_RETAILERS, proxyHost() (+1 more)

### Community 82 - "Polar Extension Background"
Cohesion: 0.40
Nodes (10): _0x2c5e78(), _0x310464(), _0x34e8df(), _0x37a042(), _0x3a8e07(), _0x3b5128(), _0x3dfda2(), _0x4bb50e() (+2 more)

### Community 83 - "Renderer Components"
Cohesion: 0.40
Nodes (9): CartAttemptTable(), formatAttemptNumber(), formatCartResult(), formatDuration(), labelize(), LeaseSummary(), MilestoneStrip(), STAGE_ORDER (+1 more)

### Community 84 - "Automation Cookiemanager"
Cohesion: 0.28
Nodes (3): CookieManager, log, RETAILER_COOKIE_URLS

### Community 85 - "Experimental Ratelimiter"
Cohesion: 0.25
Nodes (3): log, RATE_LIMITS, RateLimiter

### Community 87 - "Preload Index"
Cohesion: 0.22
Nodes (7): electron, eventChannels, invokeChannels, IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS, handlers, register()

### Community 88 - "Roadmaps Improvements"
Cohesion: 0.25
Nodes (8): Database Migration System, Dynamic Encryption Salt, Improvements Summary, Unwired Rate Limiter Prototype, Electron React Node Desktop App, PokeBot 2, Release Safety Policy, Safe Storage Credential Protection

### Community 89 - "Target Electron"
Cohesion: 0.29
Nodes (8): Target Electron Resilience Implementation Plan, Single-Owner Realtime Recovery, Target Monitoring and Durable Delivery Implementation Plan, Durable Idempotent Delivery Outbox, Target Reliability Production Rollout Implementation Plan, Dependency-Ordered Gated Production Rollout, Bounded Hot Set and Durable Outbox, Target Hot-Set Coverage and Durable Notifications

### Community 90 - "Scripts Check"
Cohesion: 0.25
Nodes (7): failures, forbiddenTrackedFile, markdownFiles, requiredIndexes, tracked, trackedDirectories, trackedSet

### Community 91 - "Automation Checkoutdiagnostics"
Cohesion: 0.43
Nodes (5): captureSafePageState(), makeDiagnosticsPath(), safeSegment(), safeUrl(), startCheckoutDiagnostics()

### Community 96 - "Package Json"
Cohesion: 0.29
Nodes (6): author, description, main, name, type, version

### Community 97 - "Options Polar Extension"
Cohesion: 0.29
Nodes (7): AI Recovery Settings, Billing Profiles, Diagnostic Logs, Polar Assist Bot Settings, Checkout Behavior, Polar Assist Bot Popup, Price Check

### Community 98 - "Scripts Drop"
Cohesion: 0.33
Nodes (4): push_to_pokebot(), Push Walmart restock drops from the Pi's existing monitor into PokeBot's…, Insert a Walmart restock into the PokeBot `drops` table. Parameters ----------…, Test the PokeBot drop pusher with a dry-run. Run on the Pi.

### Community 100 - "Proxies Proxyimport"
Cohesion: 0.62
Nodes (5): downloadProxies(), normalizeProxy(), parseProxyLine(), parseProxyList(), parseUrlProxy()

### Community 102 - "Automation Flows"
Cohesion: 0.38
Nodes (3): baseLocator(), getByRole(), locator()

### Community 103 - "Control Plane"
Cohesion: 0.40
Nodes (6): Pokebot Central Monitoring Worker Implementation Plan, Horizontally Scalable Listing Leases, Pokebot Control Plane Implementation Plan, Local Checkout Trust Boundary, Pokebot Multi-Tenant Control Plane and Central Monitoring, Tenant-Isolated Control Plane

### Community 104 - "Ref Counted"
Cohesion: 0.33
Nodes (6): Atomic Subscription Ref-count Trigger, Ref-counted Central Monitoring Implementation Plan, Ref-counted Central Monitoring Design, Global Subscriber Count Invariant, Admin Pin and Website Monitoring Toggle Design, Pinned-or-Subscribed Active Invariant

### Community 105 - "Resources Icon"
Cohesion: 0.33
Nodes (6): Application Icon, Atom Symbol, Dark and Cyan Palette, Electron Nodes, Orbital Paths, Science and Technology Identity

### Community 106 - "Security Renderersecurity"
Cohesion: 0.73
Nodes (4): configureRendererSecurity(), isSafeExternalUrl(), isTrustedRendererUrl(), openExternalUrl()

### Community 107 - "Renderer Pages"
Cohesion: 0.53
Nodes (5): maskProxy(), Proxies(), proxyHost(), renderStatusLight(), RETAILERS

### Community 108 - "Scripts Run"
Cohesion: 0.40
Nodes (4): allowedCommands, child, cliPath, env

### Community 109 - "Health Startupdiagnostics"
Cohesion: 0.90
Nodes (4): fail(), pass(), runCheck(), runStartupDiagnostics()

### Community 110 - "Tasks Taskstate"
Cohesion: 0.70
Nodes (3): listTasksToResume(), persistTaskState(), TASK_STATE

### Community 111 - "Account Registration"
Cohesion: 0.50
Nodes (4): Account Registration Automation Implementation Plan, Unverified Account Registration, Account Registration Automation Design, Account Verification Status Lifecycle

### Community 112 - "Supabase Monitor"
Cohesion: 0.50
Nodes (4): PokeBot Supabase Monitor Mode B2 Implementation Plan, Local-to-Supabase Signal Source Toggle, Supabase Monitor Mode B2 Design, Private Per-Product Realtime Broadcast

### Community 113 - "Electron App"
Cohesion: 0.50
Nodes (4): Electron App Auth Implementation Plan, Encrypted Refresh Token Session Persistence, Per-user Auth for the Electron App, Per-User Supabase Identity

### Community 114 - "Target Polar"
Cohesion: 0.50
Nodes (4): Target Polar-Like Cart Retries Implementation Plan, Response-Aware Cart Attempt Controller, Classified Polar-Like Aggression, Target High-Demand Browser Checkout Design

### Community 115 - "Checkout Account"
Cohesion: 0.50
Nodes (4): Account Checkout Ownership Lease, Checkout Account Ownership Implementation Plan, Checkout Observability Implementation Plan, Privacy-Safe Local Checkout Metadata

### Community 116 - "Electron Builder"
Cohesion: 0.50
Nodes (4): CloakBrowser ASAR Unpack, GitHub Release Publishing, PokeBot 2 Packaging, Runtime Chromium Download

### Community 117 - "Polar Extension Icons"
Cohesion: 0.67
Nodes (4): Circular Tech Badge, Polar Extension Icon, Icy Cyberpunk Palette, Polar Bear Mascot

### Community 118 - "Polar Extension Icons"
Cohesion: 0.67
Nodes (4): Circular Dark Badge, Cool Cyan and White Palette, Polar Extension 48px Icon, Polar Bear Mascot

### Community 119 - "Scripts Diagnostics"
Cohesion: 0.50
Nodes (3): candidateIds, cookieStore, redis

### Community 120 - "Scripts Diagnostics"
Cohesion: 0.50
Nodes (3): cookieStore, itemId, redis

### Community 121 - "Renderer Index"
Cohesion: 0.50
Nodes (4): Renderer Content Security Policy, Renderer Entry Document, Renderer Layout, Tasks Screen Catalog Workflow

### Community 122 - "Renderer Assets"
Cohesion: 0.50
Nodes (4): Blue-to-Magenta Gradient, Layered Wave Curves, Translucent Background Decoration, Wavy Lines Graphic

### Community 123 - "Renderer Components"
Cohesion: 0.67
Nodes (3): eta(), PHASE, QueuePanel()

### Community 124 - "Roadmaps Complete"
Cohesion: 0.67
Nodes (3): Background Monitoring, Complete Implementation Plan, Encrypted Storage Frontend

### Community 125 - "Roadmaps Github"
Cohesion: 0.67
Nodes (3): GitHub Research Improvements, Nodriver Integration, Pure Request-Based Mode

### Community 126 - "Polar Extension Icons"
Cohesion: 0.67
Nodes (3): Polar Extension 16px Icon, Circular Technology Emblem, Stylized Polar Bear Mascot

### Community 130 - "Renderer Assets"
Cohesion: 1.00
Nodes (3): Atomic Orbital Motif, Electron Framework, Electron Logo

## Ambiguous Edges - Review These
- `Browser-Only Target Checkout Policy` → `Browser-Context API Call`  [AMBIGUOUS]
  docs/operations/2026-08-11-target-reliability-rollout.md · relation: conceptually_related_to

## Knowledge Gaps
- **378 isolated node(s):** `_0x256819`, `_0x4c13e2`, `_0x479e8a`, `_0x735682`, `_0x145f4c` (+373 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **37 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Browser-Only Target Checkout Policy` and `Browser-Context API Call`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `createModuleLogger()` connect `Utils Logger` to `Automation Flows`, `Automation Browserpool`, `Telemetry Checkouttelemetry`, `Tasks Dropeventledger`, `Automation Queuejoiner`, `Ipc Supabase`, `Utils Retrymanager`, `Proxies Proxyhealthmonitor`, `Automation Api`, `Automation Flows`, `Monitor Retailers`, `Automation Nativeinputbridge`, `Monitor Retailers`, `Tasks Ordersubmissiongate`, `Index Lifecycle`, `Automation Pokemoncenterqueuejoiner`, `Monitor Monitorbrowsercontext`, `Automation Profilewarmup`, `Experimental Queueoptimizer`, `Automation Cookiemanager`, `Experimental Ratelimiter`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Why does `TaskManager` connect `Tasks Taskmanager` to `Tasks Taskmanager`, `Tasks Dropeventledger`, `Tasks Ordersubmissiongate`, `Tasks Taskmanager`, `Index Lifecycle`, `Tasks Taskmanager`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `BrowserPool` connect `Automation Browserpool` to `Index Lifecycle`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **What connects `_0x256819`, `_0x4c13e2`, `_0x479e8a` to the rest of the system?**
  _378 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Options Polar Extension` be split into smaller, more focused modules?**
  _Cohesion score 0.05147808358817533 - nodes in this community are weakly interconnected._
- **Should `Scripts Pokemon` be split into smaller, more focused modules?**
  _Cohesion score 0.05524537173082574 - nodes in this community are weakly interconnected._