import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import { RETAILER_BUY_LIMITS } from '../../../shared/constants'

export default function Catalog() {
  const { catalogItems, catalogMessage, addCatalogUrl, deleteCatalogItem, createTask } =
    useAppStore()
  const [productUrl, setProductUrl] = useState('')
  const [status, setStatus] = useState('')
  const [busyId, setBusyId] = useState('')

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
    setBusyId(item.id)
    setStatus('Creating task...')
    try {
      await createTask({
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
      setStatus('Task created. Go to Tasks, edit it, select accounts, then run Test.')
    } catch (err) {
      setStatus(err.message || 'Could not create task')
    } finally {
      setBusyId('')
    }
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
                disabled={busyId === item.id}
                className="text-green-400 hover:text-green-200 disabled:text-gray-700 uppercase tracking-wider"
              >
                create task
              </button>
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
