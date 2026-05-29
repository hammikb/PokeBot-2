import { useAppStore } from '../store/appStore'

const FIELDS = [
  { key: 'discordWebhook', label: 'Discord Webhook URL', type: 'text', placeholder: 'https://discord.com/api/webhooks/...' },
  { key: 'twilioSid', label: 'Twilio Account SID', type: 'text', placeholder: 'ACxxxxxxxx' },
  { key: 'twilioToken', label: 'Twilio Auth Token', type: 'password', placeholder: '••••••••' },
  { key: 'twilioFrom', label: 'Twilio From Number', type: 'text', placeholder: '+1XXXXXXXXXX' },
  { key: 'twilioTo', label: 'SMS Alert Number', type: 'text', placeholder: '+1XXXXXXXXXX' },
  { key: 'maxConcurrent', label: 'Max Concurrent Browsers', type: 'number', placeholder: '3' }
]

export default function Settings() {
  const { settings, saveSetting } = useAppStore()

  return (
    <div className="p-4 space-y-4 max-w-lg overflow-y-auto h-full">
      <h2 className="text-xs uppercase tracking-widest text-gray-400">Settings</h2>
      {FIELDS.map(f => (
        <div key={f.key}>
          <label className="text-gray-500 uppercase tracking-wider text-xs block mb-1">{f.label}</label>
          <input
            type={f.type}
            placeholder={f.placeholder}
            defaultValue={settings[f.key] ?? ''}
            onBlur={e => { if (e.target.value !== (settings[f.key] ?? '').toString()) saveSetting(f.key, e.target.value) }}
            key={`${f.key}-${settings[f.key]}`}
            className="w-full bg-[#111] border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 focus:border-red-500 outline-none transition-colors"
          />
        </div>
      ))}
      <div className="text-gray-600 text-xs pt-2">Settings saved automatically on field blur.</div>
    </div>
  )
}
