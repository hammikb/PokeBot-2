import { useAppStore } from '../store/appStore'

const FIELDS = [
  { key: 'maxConcurrent', label: 'Max Concurrent Browsers', type: 'number', placeholder: '3' }
]

export default function Settings() {
  const { settings, saveSetting, setMonitorMode, signOut } = useAppStore()
  const mode = settings.monitorMode || 'local'

  return (
    <div className="p-4 space-y-5 max-w-lg overflow-y-auto h-full">
      <h2 className="text-sm uppercase tracking-widest text-gray-400">Settings</h2>

      <div>
        <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
          Monitoring Source
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMonitorMode('local')}
            className={`flex-1 px-3 py-2 rounded uppercase tracking-wider text-sm font-bold border ${
              mode === 'local'
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-[#111] border-gray-700 text-gray-400'
            }`}
          >
            Local
          </button>
          <button
            type="button"
            onClick={() => setMonitorMode('supabase')}
            className={`flex-1 px-3 py-2 rounded uppercase tracking-wider text-sm font-bold border ${
              mode === 'supabase'
                ? 'bg-red-600 border-red-500 text-white'
                : 'bg-[#111] border-gray-700 text-gray-400'
            }`}
          >
            Supabase
          </button>
        </div>
        <div className="text-gray-600 text-sm mt-1.5">
          {mode === 'local'
            ? 'This computer polls retailers directly.'
            : 'Receives drops from the central Supabase monitor. Restarts running tasks.'}
        </div>
      </div>

      <div>
        <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
          Walmart Monitor Method
        </label>
        <select
          value={settings.walmartMonitorMethod || 'axios'}
          onChange={(e) => saveSetting('walmartMonitorMethod', e.target.value)}
          className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none"
        >
          <option value="axios">Lightweight HTTP (recommended)</option>
          <option value="browser">Browser interception (fallback)</option>
        </select>
        <div className="text-gray-600 text-sm mt-1.5">
          HTTP uses far less bandwidth and proxy data. Use browser mode only when a listing blocks
          HTTP checks.
        </div>
      </div>

      <div>
        <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
          Pokemon Center Queue Browser
        </label>
        <select
          value={settings.pokemonCenterQueueBrowser || 'managed'}
          onChange={(e) => saveSetting('pokemonCenterQueueBrowser', e.target.value)}
          className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none"
        >
          <option value="managed">Managed Chromium (automatic tracking)</option>
          <option value="system">System browser (survives app exit)</option>
        </select>
        <div className="text-gray-600 text-sm mt-1.5">
          System browser opens your normal Chrome or default browser and remains open if PokeBot
          closes. Managed mode can track the queue and notify you when your turn arrives.
        </div>
      </div>

      <div className="border border-gray-800 rounded-lg p-3 bg-[#0d0d0f]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-gray-300 uppercase tracking-wider text-sm">Target Cart API</div>
            <div className="text-gray-600 text-sm mt-1">
              Experimental. Browser-first is recommended while Target is rate limiting the API.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.targetCartApiEnabled === true}
            onClick={() =>
              saveSetting('targetCartApiEnabled', settings.targetCartApiEnabled !== true)
            }
            className={`relative w-12 h-7 rounded-full shrink-0 transition-colors ${
              settings.targetCartApiEnabled === true ? 'bg-red-600' : 'bg-gray-700'
            }`}
          >
            <span
              className={`pointer-events-none absolute left-0 top-1 w-5 h-5 bg-white rounded-full transition-transform ${
                settings.targetCartApiEnabled === true ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
            <span className="sr-only">
              {settings.targetCartApiEnabled === true
                ? 'Disable Target cart API'
                : 'Enable Target cart API'}
            </span>
          </button>
        </div>
        <div className="text-xs mt-2 text-gray-500">
          Current: {settings.targetCartApiEnabled === true ? 'API on' : 'Browser-first'}
        </div>
      </div>

      <div className="border border-gray-800 rounded-lg p-3 bg-[#0d0d0f]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-gray-300 uppercase tracking-wider text-sm">
              Target Checkout Lite Mode
            </div>
            <div className="text-gray-600 text-sm mt-1">
              Blocks media, fonts, and known third-party ads while preserving checkout and challenge
              traffic.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.targetCheckoutLiteMode === true}
            onClick={() =>
              saveSetting('targetCheckoutLiteMode', settings.targetCheckoutLiteMode !== true)
            }
            className={`relative w-12 h-7 rounded-full shrink-0 transition-colors ${
              settings.targetCheckoutLiteMode === true ? 'bg-red-600' : 'bg-gray-700'
            }`}
          >
            <span
              className={`pointer-events-none absolute left-0 top-1 w-5 h-5 bg-white rounded-full transition-transform ${
                settings.targetCheckoutLiteMode === true ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
            <span className="sr-only">
              {settings.targetCheckoutLiteMode === true
                ? 'Disable Target checkout lite mode'
                : 'Enable Target checkout lite mode'}
            </span>
          </button>
        </div>
        <div className="text-xs mt-2 text-gray-500">
          Current: {settings.targetCheckoutLiteMode === true ? 'Lite mode on' : 'Full page loading'}
        </div>
      </div>

      {FIELDS.map((field) => (
        <div key={field.key}>
          <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
            {field.label}
          </label>
          <input
            type={field.type}
            placeholder={field.placeholder}
            defaultValue={settings[field.key] ?? ''}
            onBlur={(e) => {
              if (e.target.value !== (settings[field.key] ?? '').toString()) {
                saveSetting(field.key, e.target.value)
              }
            }}
            key={`${field.key}-${settings[field.key]}`}
            className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none transition-colors"
          />
        </div>
      ))}

      <div className="text-gray-600 text-sm pt-2">Settings saved automatically on field blur.</div>

      <div className="pt-4 border-t border-gray-800">
        <button
          type="button"
          onClick={signOut}
          className="text-red-500 hover:text-red-300 uppercase tracking-wider text-sm"
        >
          Sign Out
        </button>
      </div>
    </div>
  )
}
