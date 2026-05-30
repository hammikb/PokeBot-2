import { useState } from 'react'
import { useAppStore } from '../store/appStore'

const RETAILERS = ['target', 'walmart']
const DIRECT_CONNECTION_KEY = '__direct_connection__'

export default function Proxies() {
  const {
    settings,
    saveSetting,
    downloadProxies,
    runProxyTest,
    runAllProxyTests,
    clearProxyTestResults,
    proxyTestResults,
    proxyTestRunState,
    proxyTestMessage
  } = useAppStore()
  const [proxyUrl, setProxyUrl] = useState(settings.proxyDownloadUrl || '')
  const [hasEditedProxyUrl, setHasEditedProxyUrl] = useState(false)
  const [downloadStatus, setDownloadStatus] = useState('')
  const proxies = Array.isArray(settings.proxies) ? settings.proxies : []
  const displayedProxyUrl = hasEditedProxyUrl ? proxyUrl : settings.proxyDownloadUrl || ''

  const importProxies = async () => {
    const downloadUrl = displayedProxyUrl.trim()
    if (!downloadUrl) return

    setDownloadStatus('Downloading proxies...')
    try {
      const result = await downloadProxies(downloadUrl)
      await saveSetting('proxyDownloadUrl', downloadUrl)
      await saveSetting('proxies', result.proxies)
      setDownloadStatus(`Imported ${result.count} proxies`)
    } catch (err) {
      setDownloadStatus(err.message || 'Proxy download failed')
    }
  }

  const testAll = async () => {
    runAllProxyTests(proxies)
  }

  const clearProxies = async () => {
    await saveSetting('proxies', [])
    await clearProxyTestResults()
    setDownloadStatus('Proxy list cleared')
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-sm uppercase tracking-widest text-gray-400">
            Proxies ({proxies.length})
          </h2>
          <p className="text-gray-600 text-sm mt-1">
            Import direct username/password proxies, then test each one against Target and Walmart.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={testAll}
            disabled={proxies.length === 0 || proxyTestRunState === 'running'}
            className="text-sm border border-green-700 text-green-400 hover:border-green-500 disabled:border-gray-800 disabled:text-gray-700 px-4 py-2 rounded uppercase tracking-wider font-bold"
          >
            {proxyTestRunState === 'running' ? 'Testing...' : 'Test All'}
          </button>
          <button
            type="button"
            onClick={clearProxies}
            disabled={proxies.length === 0}
            className="text-sm border border-gray-700 text-gray-400 hover:border-gray-500 disabled:border-gray-800 disabled:text-gray-700 px-4 py-2 rounded uppercase tracking-wider"
          >
            Clear
          </button>
        </div>
      </div>

      <section className="bg-[#111] border border-gray-800 rounded p-4 space-y-3 text-sm">
        <div>
          <label className="text-gray-500 uppercase tracking-wider block mb-1">
            Webshare Download URL
          </label>
          <input
            type="password"
            placeholder="https://proxy.webshare.io/api/v2/proxy/list/download/..."
            value={displayedProxyUrl}
            onChange={(e) => {
              setHasEditedProxyUrl(true)
              setProxyUrl(e.target.value)
            }}
            className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200 focus:border-red-500 outline-none"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={importProxies}
            disabled={!displayedProxyUrl.trim()}
            className="text-sm bg-red-600 hover:bg-red-500 disabled:bg-gray-800 disabled:text-gray-600 px-4 py-2 rounded uppercase tracking-wider font-bold"
          >
            Download Proxies
          </button>
          <span className="text-gray-600">
            {downloadStatus || proxyTestMessage || 'No proxy checks run yet'}
          </span>
        </div>
      </section>

      <div className="space-y-3">
        <div className="bg-[#111] border border-gray-800 rounded px-4 py-4 grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center text-sm">
          <div className="min-w-0">
            <div className="text-gray-200 truncate">Direct Connection</div>
            <div className="text-gray-600 truncate">Uses this computer normal internet/IP</div>
          </div>
          {RETAILERS.map((retailer) => (
            <div key={retailer}>
              {renderStatusLight(retailer, proxyTestResults[DIRECT_CONNECTION_KEY]?.[retailer])}
            </div>
          ))}
          <button
            type="button"
            onClick={() => runProxyTest(null)}
            className="text-blue-400 hover:text-blue-200 uppercase tracking-wider"
          >
            test
          </button>
        </div>

        {proxies.map((proxy) => (
          <div
            key={proxy}
            className="bg-[#111] border border-gray-800 rounded px-4 py-4 grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center text-sm"
          >
            <div className="min-w-0">
              <div className="text-gray-200 truncate">{maskProxy(proxy)}</div>
              <div className="text-gray-600 truncate">{proxyHost(proxy)}</div>
            </div>
            {RETAILERS.map((retailer) => (
              <div key={retailer}>
                {renderStatusLight(retailer, proxyTestResults[proxy]?.[retailer])}
              </div>
            ))}
            <button
              type="button"
              onClick={() => runProxyTest(proxy)}
              className="text-blue-400 hover:text-blue-200 uppercase tracking-wider"
            >
              test
            </button>
          </div>
        ))}
        {proxies.length === 0 && (
          <div className="text-gray-600 text-sm">
            No proxies imported yet. Paste your Webshare download URL above and click Download
            Proxies.
          </div>
        )}
      </div>
    </div>
  )
}

function renderStatusLight(retailer, status) {
  const current = status || { state: 'idle', label: 'Not tested' }
  const color =
    current.state === 'pass'
      ? 'bg-green-400 text-green-300'
      : current.state === 'fail'
        ? 'bg-red-400 text-red-300'
        : current.state === 'testing'
          ? 'bg-yellow-400 text-yellow-300'
          : 'bg-gray-700 text-gray-500'

  return (
    <div className="flex items-center gap-2 min-w-32">
      <span className={`w-2 h-2 rounded-full ${color.split(' ')[0]}`} />
      <span className={`uppercase tracking-wider ${color.split(' ')[1]}`}>
        {retailer}: {current.label}
      </span>
    </div>
  )
}

function maskProxy(proxy) {
  const parts = proxy.split(':')
  if (parts.length < 4) return proxy
  return `${parts[0]}:${parts[1]}:${parts[2]}:password hidden`
}

function proxyHost(proxy) {
  const [host, port] = proxy.split(':')
  return host && port ? `${host}:${port}` : proxy
}
