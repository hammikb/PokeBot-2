import { useAppStore } from '../store/appStore'

const FIELDS = [
  {
    key: 'discordWebhook',
    label: 'Discord Webhook URL',
    type: 'text',
    placeholder: 'https://discord.com/api/webhooks/...'
  },
  { key: 'twilioSid', label: 'Twilio Account SID', type: 'text', placeholder: 'ACxxxxxxxx' },
  { key: 'twilioToken', label: 'Twilio Auth Token', type: 'password', placeholder: '••••••••' },
  { key: 'twilioFrom', label: 'Twilio From Number', type: 'text', placeholder: '+1XXXXXXXXXX' },
  { key: 'twilioTo', label: 'SMS Alert Number', type: 'text', placeholder: '+1XXXXXXXXXX' },
  { key: 'maxConcurrent', label: 'Max Concurrent Browsers', type: 'number', placeholder: '3' }
]

// URL + publishable key are baked into the app (src/main/supabase/config.js).
// Users only provide login credentials.
const SUPABASE_FIELDS = [
  { key: 'supabaseEmail', label: 'Bot Email', type: 'text', placeholder: 'bot@example.com' }
]

export default function Settings() {
  const { settings, saveSetting, setMonitorMode, setSupabasePassword, clearSupabaseCredentials } =
    useAppStore()
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

      {mode === 'supabase' &&
        SUPABASE_FIELDS.map((field) => (
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

      {mode === 'supabase' && (
        <div>
          <label className="text-gray-500 uppercase tracking-wider text-sm block mb-1.5">
            Bot Password
          </label>
          <input
            type="password"
            placeholder="••••••••"
            onBlur={(e) => {
              if (e.target.value) setSupabasePassword(e.target.value)
            }}
            className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 focus:border-red-500 outline-none transition-colors"
          />
          <div className="text-gray-600 text-sm mt-1">
            Stored encrypted. Leave blank to keep current.
          </div>
          {(settings.supabaseEmail || settings.supabasePasswordEnc) && (
            <button
              type="button"
              onClick={clearSupabaseCredentials}
              className="mt-2 text-red-500 hover:text-red-300 uppercase tracking-wider text-sm"
            >
              Clear stored bot credentials
            </button>
          )}
        </div>
      )}

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
    </div>
  )
}
