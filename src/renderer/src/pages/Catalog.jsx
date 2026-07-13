import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../store/appStore'
import { RETAILER_BUY_LIMITS } from '../../../shared/constants'

export default function Catalog() {
  const {
    catalogItems,
    catalogMessage,
    addCatalogUrl,
    deleteCatalogItem,
    createTask,
    supabaseCatalog,
    loadSupabaseCatalog,
    tasks,
    walmartMatches,
    walmartCandidates,
    loadWalmartMatches,
    findWalmartMatch,
    dismissWalmartCandidates,
    confirmWalmartMatch
  } = useAppStore()
  const navigate = useNavigate()
  const [productUrl, setProductUrl] = useState('')
  const [status, setStatus] = useState('')
  const [busyId, setBusyId] = useState('')
  const [catalogFilter, setCatalogFilter] = useState('')

  const taskedProductUrls = new Set(tasks.map((task) => task.product_url))

  const filteredSupabaseCatalog = supabaseCatalog.filter((item) =>
    (item.name || item.product_key || '').toLowerCase().includes(catalogFilter.toLowerCase())
  )

  useEffect(() => {
    loadSupabaseCatalog().catch(() => {})
    loadWalmartMatches().catch(() => {})
  }, [])

  const addUrl = async (event) => {
    event.preventDefault()
    const url = productUrl.trim()
    if (!url) return

    setStatus('Adding catalog item...')
    try {
      const item = await addCatalogUrl(url)
      setProductUrl('')
      setStatus(
        item?.status === 'blocked'
          ? 'Saved by item ID, but Target/Walmart blocked live details. Refresh after clearing CAPTCHA or try again later.'
          : 'Catalog item saved'
      )
    } catch (err) {
      setStatus(err.message || 'Could not add catalog item')
    }
  }

  const createTaskFromItem = async (item) => {
    if (taskedProductUrls.has(item.product_url)) {
      setStatus('A task for this item already exists.')
      return
    }
    setBusyId(item.id)
    setStatus('Creating task...')
    try {
      const id = await createTask({
        retailer: item.retailer,
        productUrl: item.product_url,
        productName: item.title,
        productImageUrl: item.image_url,
        buyLimit: RETAILER_BUY_LIMITS[item.retailer] || 1,
        maxPrice: item.msrp || item.current_price || null,
        mode: 'monitor-and-buy',
        accountIds: [],
        intervalMs: 4000
      })
      navigate('/tasks', { state: { editTaskId: id } })
    } catch (err) {
      setStatus(err.message || 'Could not create task')
    } finally {
      setBusyId('')
    }
  }

  const refreshSupabaseCatalog = async () => {
    setStatus('Loading central catalog...')
    try {
      await loadSupabaseCatalog()
      setStatus('')
    } catch (err) {
      setStatus(err.message || 'Could not load central catalog')
    }
  }

  const createTaskFromSupabaseItem = async (item) => {
    if (taskedProductUrls.has(item.product_url)) {
      setStatus('A task for this item already exists.')
      return
    }
    setBusyId(item.id)
    setStatus('Creating task...')
    try {
      const id = await createTask({
        retailer: item.retailer,
        productUrl: item.product_url,
        productName: item.name,
        buyLimit: RETAILER_BUY_LIMITS[item.retailer] || 1,
        maxPrice: null,
        mode: 'monitor-and-buy',
        accountIds: [],
        intervalMs: 4000
      })
      navigate('/tasks', { state: { editTaskId: id } })
    } catch (err) {
      setStatus(err.message || 'Could not create task')
    } finally {
      setBusyId('')
    }
  }

  const searchWalmartMatch = async (item) => {
    setBusyId(item.id)
    setStatus('Searching Walmart...')
    try {
      await findWalmartMatch(item.product_key, item.upc, item.name)
      setStatus('')
    } catch (err) {
      setStatus(err.message || 'Walmart search failed')
    } finally {
      setBusyId('')
    }
  }

  const createWalmartTask = async (item, { productUrl, productName }) => {
    if (taskedProductUrls.has(productUrl)) {
      setStatus('A task for this item already exists.')
      return
    }
    setBusyId(item.id)
    setStatus('Creating task...')
    try {
      const id = await createTask({
        retailer: 'walmart',
        productUrl,
        productName,
        buyLimit: RETAILER_BUY_LIMITS.walmart || 1,
        maxPrice: null,
        mode: 'monitor-and-buy',
        accountIds: [],
        intervalMs: 4000
      })
      navigate('/tasks', { state: { editTaskId: id } })
    } catch (err) {
      setStatus(err.message || 'Could not create task')
    } finally {
      setBusyId('')
    }
  }

  const applyWalmartCandidate = async (item, candidate) => {
    setBusyId(item.id)
    setStatus('Saving match...')
    try {
      await confirmWalmartMatch(item.product_key, candidate)
    } catch (err) {
      setStatus(err.message || 'Could not save Walmart match')
      setBusyId('')
      return
    }
    await createWalmartTask(item, { productUrl: candidate.url, productName: candidate.name })
  }

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full">
      <div>
        <h2 className="text-sm uppercase tracking-widest text-gray-400">
          Catalog ({catalogItems.length})
        </h2>
        <p className="text-gray-600 text-sm mt-1">
          Save known Target TCINs and Walmart item IDs so tasks can be created from stable product
          records instead of live keyword search.
        </p>
      </div>

      <form
        onSubmit={addUrl}
        className="bg-[#111] border border-gray-800 rounded p-4 space-y-3 text-sm"
      >
        <label className="text-gray-500 uppercase tracking-wider block">Add Product URL</label>
        <div className="flex gap-2">
          <input
            value={productUrl}
            onChange={(event) => setProductUrl(event.target.value)}
            placeholder="https://www.target.com/p/guppy/A-95267143"
            className="flex-1 bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
          />
          <button
            type="submit"
            disabled={!productUrl.trim()}
            className="bg-red-600 hover:bg-red-500 disabled:bg-gray-800 disabled:text-gray-600 px-4 py-2 rounded uppercase tracking-wider font-bold"
          >
            Add
          </button>
        </div>
        <div className="text-gray-600">
          {status || catalogMessage || 'Paste a Target or Walmart product URL.'}
        </div>
      </form>

      <div className="bg-[#111] border border-gray-800 rounded p-4 space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <label className="text-gray-500 uppercase tracking-wider block">
            Target Catalog ({supabaseCatalog.length})
          </label>
          <button
            type="button"
            onClick={refreshSupabaseCatalog}
            className="text-purple-400 hover:text-purple-200 uppercase tracking-wider"
          >
            Refresh
          </button>
        </div>
        <p className="text-gray-600">
          Read-only reference list from PokeAlert — pick one to create a task from it.
        </p>
        <input
          value={catalogFilter}
          onChange={(event) => setCatalogFilter(event.target.value)}
          placeholder="Filter by name..."
          className="w-full bg-[#0f0f0f] border border-gray-700 rounded px-3 py-2 text-gray-200"
        />
        <div className="space-y-2 max-h-[36rem] overflow-y-auto">
          {filteredSupabaseCatalog.map((item) => {
            const walmartMatch = walmartMatches[item.product_key]
            const candidates = walmartCandidates[item.product_key]
            return (
              <div
                key={item.id}
                className="flex items-center justify-between gap-4 bg-[#0f0f0f] border border-gray-800 rounded px-4 py-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {item.image ? (
                    <img
                      src={item.image}
                      alt=""
                      className="w-16 h-16 object-contain bg-white rounded shrink-0"
                    />
                  ) : (
                    <div className="w-16 h-16 bg-gray-800 rounded shrink-0" />
                  )}
                  <div className="min-w-0">
                    <span className="text-red-400 uppercase mr-2">{item.retailer}</span>
                    <span className="text-gray-100 text-base truncate">
                      {item.name || item.product_key}
                    </span>
                    {candidates && (
                      <div className="mt-1.5 space-y-1">
                        {candidates.length === 0 && (
                          <div className="text-gray-600 text-sm">
                            No Walmart match found.{' '}
                            <button
                              type="button"
                              onClick={() => dismissWalmartCandidates(item.product_key)}
                              className="text-gray-500 hover:text-gray-300 underline"
                            >
                              dismiss
                            </button>
                          </div>
                        )}
                        {candidates.map((candidate) => (
                          <div key={candidate.itemId} className="flex items-center gap-2 text-sm">
                            <span
                              className={
                                candidate.confidence === 'upc' ? 'text-blue-400' : 'text-yellow-500'
                              }
                            >
                              {candidate.confidence === 'upc' ? 'UPC match' : 'unverified'}
                            </span>
                            <span
                              className={
                                candidate.retailerOwnedListing ? 'text-emerald-400' : 'text-orange-400'
                              }
                            >
                              {candidate.retailerOwnedListing
                                ? 'sold by Walmart'
                                : `sold by ${candidate.sellerName || 'a marketplace seller'}`}
                            </span>
                            <span className="text-gray-400 truncate">{candidate.name}</span>
                            <button
                              type="button"
                              onClick={() => applyWalmartCandidate(item, candidate)}
                              disabled={busyId === item.id}
                              className="text-green-400 hover:text-green-200 disabled:text-gray-700 uppercase tracking-wider shrink-0"
                            >
                              use this
                            </button>
                          </div>
                        ))}
                        {candidates.length > 0 && (
                          <button
                            type="button"
                            onClick={() => dismissWalmartCandidates(item.product_key)}
                            className="text-gray-500 hover:text-gray-300 underline text-sm"
                          >
                            none of these
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => createTaskFromSupabaseItem(item)}
                    disabled={busyId === item.id || taskedProductUrls.has(item.product_url)}
                    className="text-green-400 hover:text-green-200 disabled:text-gray-700 uppercase tracking-wider"
                  >
                    {taskedProductUrls.has(item.product_url) ? 'target: task exists' : 'create target task'}
                  </button>
                  {walmartMatch ? (
                    <button
                      type="button"
                      onClick={() =>
                        createWalmartTask(item, {
                          productUrl: walmartMatch.walmart_url,
                          productName: walmartMatch.walmart_name
                        })
                      }
                      disabled={busyId === item.id || taskedProductUrls.has(walmartMatch.walmart_url)}
                      className="text-blue-400 hover:text-blue-200 disabled:text-gray-700 uppercase tracking-wider"
                    >
                      {taskedProductUrls.has(walmartMatch.walmart_url)
                        ? 'walmart: task exists'
                        : 'create walmart task'}
                    </button>
                  ) : (
                    !candidates && (
                      <button
                        type="button"
                        onClick={() => searchWalmartMatch(item)}
                        disabled={busyId === item.id}
                        className="text-purple-400 hover:text-purple-200 disabled:text-gray-700 uppercase tracking-wider"
                      >
                        find walmart match
                      </button>
                    )
                  )}
                </div>
              </div>
            )
          })}
          {supabaseCatalog.length === 0 && (
            <div className="text-gray-600">No items loaded yet. Click Refresh.</div>
          )}
          {supabaseCatalog.length > 0 && filteredSupabaseCatalog.length === 0 && (
            <div className="text-gray-600">No items match &quot;{catalogFilter}&quot;.</div>
          )}
        </div>
      </div>

      <div className="space-y-3">
        {catalogItems.map((item) => (
          <div
            key={item.id}
            className="bg-[#111] border border-gray-800 rounded px-4 py-4 flex gap-4 text-sm"
          >
            {item.image_url ? (
              <img
                src={item.image_url}
                alt={item.title}
                className="w-20 h-20 object-contain bg-white rounded shrink-0"
              />
            ) : (
              <div className="w-20 h-20 bg-gray-800 rounded shrink-0" />
            )}

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-red-400 uppercase">{item.retailer}</span>
                <span className="text-gray-600">
                  {item.id_type}: {item.retailer_item_id}
                </span>
                {renderStatusPill(item.status)}
              </div>
              <div className="text-gray-100 font-bold truncate mt-1">{item.title}</div>
              <div className="text-gray-500 truncate mt-1">{item.product_url}</div>
              <div className="flex flex-wrap gap-3 text-gray-500 mt-2">
                <span>MSRP {item.msrp == null ? '?' : `$${Number(item.msrp).toFixed(2)}`}</span>
                <span>Current {item.formatted_current_price || '?'}</span>
                <span>Availability {item.availability || 'unknown'}</span>
                <span>Seller {item.seller || 'unknown'}</span>
                <span>Confidence {item.fresh_stock_confidence || 'unknown'}</span>
              </div>
            </div>

            <div className="flex flex-col gap-2 shrink-0">
              <button
                type="button"
                onClick={() => createTaskFromItem(item)}
                disabled={busyId === item.id || taskedProductUrls.has(item.product_url)}
                className="text-green-400 hover:text-green-200 disabled:text-gray-700 uppercase tracking-wider"
              >
                {taskedProductUrls.has(item.product_url) ? 'task exists' : 'create task'}
              </button>
              <a
                href={item.product_url}
                target="_blank"
                rel="noreferrer"
                className={`uppercase tracking-wider ${
                  item.product_url
                    ? 'text-blue-400 hover:text-blue-200'
                    : 'text-gray-700 pointer-events-none'
                }`}
              >
                open link
              </a>
              <button
                type="button"
                onClick={() => deleteCatalogItem(item.id)}
                className="text-red-600 hover:text-red-400 uppercase tracking-wider"
              >
                delete
              </button>
            </div>
          </div>
        ))}

        {catalogItems.length === 0 && (
          <div className="text-gray-600 text-sm">
            No catalog items yet. Add a product URL above to seed the local database.
          </div>
        )}
      </div>
    </div>
  )
}

function renderStatusPill(status) {
  const color =
    status === 'active'
      ? 'text-green-300 border-green-800'
      : status === 'blocked'
        ? 'text-yellow-300 border-yellow-800'
        : 'text-red-300 border-red-800'
  return (
    <span className={`border rounded px-2 py-0.5 text-xs uppercase tracking-wider ${color}`}>
      {status || 'unknown'}
    </span>
  )
}
